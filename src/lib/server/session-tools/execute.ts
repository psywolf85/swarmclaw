/**
 * execute — Unified code execution tool with dual backends.
 *
 * Sandbox backend (default): just-bash with OverlayFS. Reads workspace
 * files from disk, writes stay in memory. Credential injection + secret
 * redaction. No npm, no background processes, no persistent writes.
 *
 * Host backend (opt-in per agent config): Real bash on the host. Full
 * system access — npm, git, background processes, persistent writes.
 * Retains current safety guards from shell.ts.
 */

import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import { spawn, type ChildProcess } from 'child_process'
import type { Extension, ExtensionHooks, Agent } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { errorMessage } from '@/lib/shared-utils'
import { log } from '../logger'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { buildCredentialEnv, redactSecrets } from './credential-env'
import type { ToolBuildContext } from './context'
import { truncate, MAX_OUTPUT } from './context'

const TAG = 'execute'

/** Agent-level configuration for the execute tool */
export interface ExecuteConfig {
  backend: 'sandbox' | 'host'
  network?: { enabled: boolean; allowedUrls?: string[] }
  runtimes?: { python?: boolean; javascript?: boolean; sqlite?: boolean }
  timeout?: number
  credentials?: string[]
}

const DEFAULT_EXECUTE_CONFIG: ExecuteConfig = {
  backend: 'sandbox',
  timeout: 30,
}

// ---------------------------------------------------------------------------
// Sandbox backend — just-bash with OverlayFS
// ---------------------------------------------------------------------------

async function executeSandbox(
  code: string,
  cwd: string,
  config: ExecuteConfig,
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  // Dynamic import to avoid loading just-bash when not needed
  const { Bash, OverlayFs } = await import('just-bash')

  const fs = new OverlayFs({
    root: cwd,
    mountPoint: '/workspace',
  })

  const timeoutMs = (config.timeout ?? 30) * 1000

  // Build credential env vars
  const { env: credEnv, secrets } = buildCredentialEnv(config.credentials ?? [])

  // Base env vars
  const env: Record<string, string> = {
    HOME: '/home/user',
    WORKSPACE: '/workspace',
    PATH: '/usr/local/bin:/usr/bin:/bin',
    TERM: 'xterm-256color',
    ...credEnv,
  }

  // Network configuration
  let network: Record<string, unknown> | undefined
  if (config.network?.enabled) {
    if (config.network.allowedUrls?.length) {
      network = {
        allowedUrls: config.network.allowedUrls.map((url: string) => ({
          url,
          methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
        })),
      }
    } else {
      // Full internet access
      network = { allowedUrls: [{ url: '*', methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] }] }
    }
  }

  const bash = new Bash({
    fs,
    env,
    cwd: '/workspace',
    executionLimits: {
      maxCommandCount: 1000,
      maxLoopIterations: 10000,
      maxCallDepth: 50,
    },
    python: config.runtimes?.python ?? false,
    javascript: config.runtimes?.javascript ?? false,
    ...(network ? { network: network as Record<string, unknown> } : {}),
    defenseInDepth: true,
  } as Record<string, unknown>)

  // Execute with timeout
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  // Compose parent signal with our timeout
  if (signal?.aborted) {
    clearTimeout(timer)
    return { stdout: '', stderr: 'Execution cancelled', exit_code: 130 }
  }
  signal?.addEventListener('abort', () => {
    clearTimeout(timer)
    controller.abort()
  }, { once: true })

  try {
    const result = await bash.exec(code, {
      signal: controller.signal,
    })
    clearTimeout(timer)

    return {
      stdout: redactSecrets(result.stdout, secrets),
      stderr: redactSecrets(result.stderr, secrets),
      exit_code: result.exitCode,
    }
  } catch (err: unknown) {
    clearTimeout(timer)
    const msg = errorMessage(err)
    if (msg.includes('abort') || msg.includes('cancel') || msg.includes('Timeout')) {
      return { stdout: '', stderr: `Execution timed out after ${config.timeout ?? 30}s`, exit_code: 124 }
    }
    return { stdout: '', stderr: `Execution error: ${redactSecrets(msg, secrets)}`, exit_code: 1 }
  }
}

// ---------------------------------------------------------------------------
// Host backend — real bash via child_process
//
// NOTE: This intentionally spawns bash to execute agent code. This is the
// same pattern used by the existing shell.ts tool. Agent code execution is
// the explicit purpose of this tool — this is not a command injection risk.
// ---------------------------------------------------------------------------

async function executeHost(
  code: string,
  cwd: string,
  config: ExecuteConfig,
): Promise<{ stdout: string; stderr: string; exit_code: number }> {
  const timeoutMs = (config.timeout ?? 30) * 1000

  // Build credential env vars
  const { env: credEnv, secrets } = buildCredentialEnv(config.credentials ?? [])

  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] != null),
    ),
    WORKSPACE: cwd,
    SESSION_CWD: cwd,
    SWARMCLAW_SANDBOX_MODE: 'host',
    ...credEnv,
  }

  return new Promise((resolve) => {
    const proc: ChildProcess = spawn('/bin/bash', ['-c', code], {
      cwd,
      env: env as NodeJS.ProcessEnv,
      timeout: timeoutMs,
    })

    let stdout = ''
    let stderr = ''
    const maxBytes = MAX_OUTPUT

    proc.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < maxBytes) stdout += chunk.toString('utf-8')
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      if (stderr.length < maxBytes) stderr += chunk.toString('utf-8')
    })

    proc.on('close', (exitCode: number | null) => {
      resolve({
        stdout: redactSecrets(stdout, secrets),
        stderr: redactSecrets(stderr, secrets),
        exit_code: exitCode ?? 1,
      })
    })

    proc.on('error', (err: Error) => {
      resolve({
        stdout: redactSecrets(stdout, secrets),
        stderr: redactSecrets(`Process error: ${err.message}`, secrets),
        exit_code: 1,
      })
    })
  })
}

// ---------------------------------------------------------------------------
// Main execute action
// ---------------------------------------------------------------------------

interface ExecuteActionContext {
  cwd: string
  agentId?: string | null
  sessionId?: string | null
  executeConfig?: ExecuteConfig | null
}

async function executeAction(
  args: Record<string, unknown>,
  ctx: ExecuteActionContext,
): Promise<string> {
  const normalized = normalizeToolInputArgs(args)
  const code = (normalized.code as string | undefined)?.trim()

  if (!code) {
    return 'Error: `code` parameter is required. Provide the bash script to execute.'
  }

  const config: ExecuteConfig = {
    ...DEFAULT_EXECUTE_CONFIG,
    ...ctx.executeConfig,
  }

  const persistent = normalized.persistent === true
  const timeoutOverride = typeof normalized.timeout === 'number' ? normalized.timeout : undefined
  if (timeoutOverride) {
    config.timeout = Math.min(Math.max(timeoutOverride, 1), 300) // Clamp 1-300s
  }

  log.info(TAG, `Executing code (backend=${config.backend}, persistent=${persistent})`, {
    agentId: ctx.agentId,
    sessionId: ctx.sessionId,
    codeLength: code.length,
  })

  try {
    let result: { stdout: string; stderr: string; exit_code: number }

    if (config.backend === 'host' || persistent) {
      // Host backend for persistent mode or explicit host config
      result = await executeHost(code, ctx.cwd, config)
    } else {
      // Sandbox backend (default)
      result = await executeSandbox(code, ctx.cwd, config)
    }

    // Format output
    const parts: string[] = []
    if (result.stdout) parts.push(result.stdout)
    if (result.stderr) parts.push(`[stderr] ${result.stderr}`)
    if (result.exit_code !== 0) parts.push(`[exit code: ${result.exit_code}]`)

    const output = parts.join('\n') || '(no output)'
    return truncate(output, MAX_OUTPUT)
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

const ExecuteExtension: Extension = {
  name: 'Core Execute',
  description: 'Execute code in a sandboxed or host bash environment with credential injection and secret redaction.',
  hooks: {
    getCapabilityDescription: () =>
      'I can execute bash scripts with the `execute` tool. ' +
      'By default, code runs in a sandboxed environment (just-bash) that reads workspace files but keeps writes in memory. ' +
      'For tasks requiring persistent writes, npm, or git, the agent can be configured to use the host backend. ' +
      'Credentials are injected as environment variables and automatically redacted from output.',
    getOperatingGuidance: () =>
      'Use `execute` for: data processing (jq, awk, sed), API calls (curl), file inspection (cat, grep, find), ' +
      'computation, and any CLI tool. ' +
      'In sandbox mode, writes are ephemeral — use the `files` tool for persistent file changes. ' +
      'In host mode, writes persist to the real filesystem.',
  } as ExtensionHooks,
  tools: [
    {
      name: 'execute',
      description:
        'Execute a bash script. Supports curl, jq, awk, sed, grep, and 70+ Unix commands. ' +
        'Credentials are injected as environment variables (e.g., $API_KEY). ' +
        'By default runs sandboxed — workspace files are readable, writes stay in memory. ' +
        'Set persistent=true for real filesystem writes (if the agent has host access).',
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'The bash script to execute' },
          persistent: { type: 'boolean', description: 'Use host backend for persistent writes (default: false)' },
          timeout: { type: 'number', description: 'Timeout in seconds (default: 30, max: 300)' },
        },
        required: ['code'],
      },
      execute: async (args, context) =>
        executeAction(args as Record<string, unknown>, {
          cwd: context.session?.cwd || process.cwd(),
        }),
    },
  ],
}

registerNativeCapability('execute', ExecuteExtension)

// ---------------------------------------------------------------------------
// Tool builder (called from session-tools/index.ts)
// ---------------------------------------------------------------------------

export function buildExecuteTools(bctx: ToolBuildContext) {
  if (!bctx.hasExtension('execute')) return []

  // Resolve execute config from the agent
  const session = bctx.resolveCurrentSession?.()
  const agent = session?.agent as (Agent & { executeConfig?: ExecuteConfig }) | undefined
  const executeConfig: ExecuteConfig = {
    ...DEFAULT_EXECUTE_CONFIG,
    ...agent?.executeConfig,
  }

  return [
    tool(
      async (args) =>
        executeAction(args, {
          cwd: bctx.cwd,
          agentId: bctx.ctx?.agentId,
          sessionId: bctx.ctx?.sessionId,
          executeConfig,
        }),
      {
        name: 'execute',
        description: ExecuteExtension.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
