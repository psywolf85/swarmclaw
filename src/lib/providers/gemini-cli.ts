import { spawn } from 'child_process'
import type { StreamChatOptions } from './index'
import { log } from '../server/logger'
import { loadRuntimeSettings } from '@/lib/server/runtime/runtime-settings'
import { resolveCliBinary, buildCliEnv, probeCliAuth, attachAbortHandler } from './cli-utils'

/**
 * Gemini CLI provider — spawns `gemini --prompt <message> --output-format stream-json --yolo`.
 * Tracks `session.geminiSessionId` from streamed JSON events to support multi-turn continuity.
 */
export function streamGeminiCliChat({ session, message, imagePath, systemPrompt, write, active, signal }: StreamChatOptions): Promise<string> {
  const processTimeoutMs = loadRuntimeSettings().cliProcessTimeoutMs
  const binary = resolveCliBinary('gemini')
  if (!binary) {
    const msg = 'Gemini CLI not found. Install it and ensure it is on your PATH.'
    write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
    return Promise.resolve('')
  }

  const env = buildCliEnv()

  // Pass API key if available
  if (session.apiKey) {
    env.GEMINI_API_KEY = session.apiKey
  }

  // Auth probe
  if (!session.apiKey) {
    const auth = probeCliAuth(binary, 'gemini', env, session.cwd)
    if (!auth.authenticated) {
      log.error('gemini-cli', auth.errorMessage || 'Auth failed')
      write(`data: ${JSON.stringify({ t: 'err', text: auth.errorMessage || 'Gemini CLI is not authenticated.' })}\n\n`)
      return Promise.resolve('')
    }
  }

  // Build prompt with optional system instructions
  const promptParts: string[] = []
  if (systemPrompt && !session.geminiSessionId) {
    promptParts.push(`[System instructions]\n${systemPrompt}`)
  }
  promptParts.push(message)
  const prompt = promptParts.join('\n\n')

  const args = ['--prompt', prompt, '--output-format', 'stream-json', '--yolo']
  if (session.geminiSessionId) args.push('--resume', session.geminiSessionId)
  if (session.model) args.push('--model', session.model)
  if (imagePath) args.push('--file', imagePath)

  log.info('gemini-cli', `Spawning: ${binary}`, {
    args: args.map((a) => a.length > 100 ? a.slice(0, 100) + '...' : a),
    cwd: session.cwd,
    promptLen: prompt.length,
    hasSystemPrompt: !!systemPrompt,
    resumeSessionId: session.geminiSessionId || null,
  })

  const proc = spawn(binary, args, {
    cwd: session.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: processTimeoutMs,
  })

  log.info('gemini-cli', `Process spawned: pid=${proc.pid}`)
  active.set(session.id, proc)
  attachAbortHandler(proc, signal)

  let fullResponse = ''
  let buf = ''
  let eventCount = 0
  let stderrText = ''

  proc.stdout!.on('data', (chunk: Buffer) => {
    const raw = chunk.toString()
    buf += raw

    if (eventCount === 0) {
      log.debug('gemini-cli', `First stdout chunk (${raw.length} bytes)`, raw.slice(0, 500))
    }

    const lines = buf.split('\n')
    buf = lines.pop()!

    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const ev = JSON.parse(line) as Record<string, unknown>
        eventCount++

        // Capture session ID from init event
        if (ev.type === 'init' && typeof ev.session_id === 'string') {
          session.geminiSessionId = ev.session_id
          log.info('gemini-cli', `Got session_id: ${ev.session_id}`)
        }

        // Streaming text deltas
        if (ev.type === 'content_block_delta') {
          const delta = ev.delta as Record<string, unknown> | undefined
          if (typeof delta?.text === 'string') {
            fullResponse += delta.text
            write(`data: ${JSON.stringify({ t: 'd', text: delta.text })}\n\n`)
          }
        }

        // Assistant message content
        else if (ev.type === 'message' && ev.role === 'assistant' && typeof ev.content === 'string') {
          fullResponse += ev.content
          write(`data: ${JSON.stringify({ t: 'd', text: ev.content })}\n\n`)
        }

        // Final result
        else if (ev.type === 'result' && typeof ev.result === 'string') {
          fullResponse = ev.result
          write(`data: ${JSON.stringify({ t: 'r', text: ev.result })}\n\n`)
          log.debug('gemini-cli', `Result event (${ev.result.length} chars)`)
        }

        // Error result
        else if (ev.type === 'result' && ev.status === 'error') {
          const errMsg = typeof ev.error === 'string' ? ev.error : 'Gemini error'
          write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
          log.warn('gemini-cli', `Error result: ${errMsg}`)
        }

        // Event error
        else if (ev.type === 'error') {
          const errMsg = typeof ev.message === 'string'
            ? ev.message
            : typeof ev.error === 'string'
              ? ev.error
              : 'Unknown Gemini error'
          write(`data: ${JSON.stringify({ t: 'err', text: errMsg })}\n\n`)
          log.warn('gemini-cli', `Event error: ${errMsg}`)
        }

        else if (eventCount <= 10) {
          log.debug('gemini-cli', `Event: ${String(ev.type)}`)
        }
      } catch {
        if (line.trim()) {
          log.debug('gemini-cli', `Non-JSON stdout line`, line.slice(0, 300))
          fullResponse += line + '\n'
          write(`data: ${JSON.stringify({ t: 'd', text: line + '\n' })}\n\n`)
        }
      }
    }
  })

  proc.stderr!.on('data', (chunk: Buffer) => {
    const text = chunk.toString()
    stderrText += text
    if (stderrText.length > 16_000) stderrText = stderrText.slice(-16_000)
    log.warn('gemini-cli', `stderr [${session.id}]`, text.slice(0, 500))
  })

  return new Promise((resolve) => {
    proc.on('close', (code, sig) => {
      log.info('gemini-cli', `Process closed: code=${code} signal=${sig} events=${eventCount} response=${fullResponse.length}chars`)
      active.delete(session.id)
      if ((code ?? 0) !== 0 && !fullResponse.trim()) {
        const msg = stderrText.trim()
          ? `Gemini CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''}: ${stderrText.trim().slice(0, 1200)}`
          : `Gemini CLI exited with code ${code ?? 'unknown'}${sig ? ` (${sig})` : ''} and returned no output.`
        write(`data: ${JSON.stringify({ t: 'err', text: msg })}\n\n`)
      }
      resolve(fullResponse)
    })

    proc.on('error', (e) => {
      log.error('gemini-cli', `Process error: ${e.message}`)
      active.delete(session.id)
      write(`data: ${JSON.stringify({ t: 'err', text: e.message })}\n\n`)
      resolve(fullResponse)
    })
  })
}
