import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import { UPLOAD_DIR } from '../storage'
import { truncate, MAX_OUTPUT } from './context'
import type { Session } from '@/types'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { detectDocker } from '@/lib/server/sandbox/docker-detect'
import {
  ensureSessionSandbox,
  resolveSandboxRuntimeStatus,
  resolveSandboxWorkdir,
  type AgentSandboxConfig,
} from '@/lib/server/sandbox/session-runtime'
import { buildDockerExecArgs } from '@/lib/server/runtime/process-manager'

export type SandboxContext = {
  sessionId?: string
  cwd?: string
  agentId?: string | null
  config?: AgentSandboxConfig | null
  resolveCurrentSession?: () => Session | null
}

const EXT_MAP: Record<string, string> = {
  javascript: 'js',
  typescript: 'ts',
}

function sandboxUnavailableError(reason: string): string {
  return JSON.stringify({
    error: reason,
    guidance: [
      'Install Docker Desktop to keep sandbox_exec inside a container.',
      'Use http_request for straightforward API calls.',
      'Use extension_creator plus manage_schedules for recurring automations.',
    ],
  })
}

function quoteShell(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function createSandboxDir(baseCwd: string, sessionId: string): string {
  const root = path.join(baseCwd, '.swarmclaw-sandbox')
  fs.mkdirSync(root, { recursive: true })
  return fs.mkdtempSync(path.join(root, `${sessionId}-`))
}

function collectArtifacts(params: {
  sandboxDir: string
  ignoredFiles: Set<string>
}): Array<{ name: string; url: string }> {
  const artifacts: { name: string; url: string }[] = []
  try {
    const files = fs.readdirSync(params.sandboxDir)
    for (const file of files) {
      if (params.ignoredFiles.has(file)) continue
      const src = path.join(params.sandboxDir, file)
      if (!fs.statSync(src).isFile()) continue
      fs.mkdirSync(UPLOAD_DIR, { recursive: true })
      const destName = `sandbox-${Date.now()}-${file}`
      const dest = path.join(UPLOAD_DIR, destName)
      fs.copyFileSync(src, dest)
      artifacts.push({ name: file, url: `/api/uploads/${encodeURIComponent(destName)}` })
    }
  } catch {
    // ignore artifact collection failures
  }
  return artifacts
}

function executeHostNode(params: {
  sandboxDir: string
  language: string
  scriptFile: string
  timeout: number
}): {
  runtime: 'host'
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
} {
  const tmpDir = path.join(params.sandboxDir, '.tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const args = params.language === 'typescript'
    ? ['--no-warnings=ExperimentalWarning', '--experimental-strip-types', params.scriptFile]
    : [params.scriptFile]
  const result = spawnSync(process.execPath, args, {
    cwd: params.sandboxDir,
    encoding: 'utf-8',
    timeout: params.timeout,
    maxBuffer: MAX_OUTPUT,
    env: {
      ...process.env,
      HOME: params.sandboxDir,
      TMPDIR: tmpDir,
      WORKSPACE: params.sandboxDir,
      SESSION_CWD: params.sandboxDir,
      SWARMCLAW_SANDBOX_MODE: 'host',
    },
  })
  return {
    runtime: 'host',
    stdout: truncate((result.stdout || '').toString(), MAX_OUTPUT),
    stderr: truncate((result.stderr || '').toString(), MAX_OUTPUT),
    exitCode: result.status ?? (result.error ? 1 : 0),
    timedOut: !!(result.error?.message?.includes('ETIMEDOUT') || result.signal === 'SIGTERM'),
  }
}

async function executeContainerNode(params: {
  sandboxDir: string
  language: string
  scriptFile: string
  timeout: number
  context: SandboxContext
}): Promise<{
  runtime: 'container'
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}> {
  const session = params.context.resolveCurrentSession?.() ?? null
  const sandbox = await ensureSessionSandbox({
    config: params.context.config,
    session,
    agentId: params.context.agentId ?? session?.agentId ?? null,
    sessionId: params.context.sessionId ?? session?.id ?? null,
    workspaceDir: params.context.cwd || process.cwd(),
  })

  if (!sandbox) {
    throw new Error('Container sandbox is not active for this session.')
  }

  const tmpDir = path.join(params.sandboxDir, '.tmp')
  fs.mkdirSync(tmpDir, { recursive: true })
  const resolved = resolveSandboxWorkdir({
    workspaceDir: sandbox.workspaceDir,
    hostWorkdir: params.sandboxDir,
    containerWorkdir: sandbox.containerWorkdir,
  })
  const containerCommand = params.language === 'typescript'
    ? `node --no-warnings=ExperimentalWarning --experimental-strip-types ${quoteShell(params.scriptFile)}`
    : `node ${quoteShell(params.scriptFile)}`
  const result = spawnSync('docker', buildDockerExecArgs({
    containerName: sandbox.containerName,
    command: containerCommand,
    workdir: resolved.containerWorkdir,
    env: {
      HOME: resolved.containerWorkdir,
      TMPDIR: path.posix.join(resolved.containerWorkdir, '.tmp'),
      WORKSPACE: sandbox.containerWorkdir,
      SESSION_CWD: resolved.containerWorkdir,
      SWARMCLAW_SANDBOX_MODE: 'container',
    },
  }), {
    encoding: 'utf-8',
    timeout: params.timeout,
    maxBuffer: MAX_OUTPUT,
  })

  return {
    runtime: 'container',
    stdout: truncate((result.stdout || '').toString(), MAX_OUTPUT),
    stderr: truncate((result.stderr || '').toString(), MAX_OUTPUT),
    exitCode: result.status ?? (result.error ? 1 : 0),
    timedOut: !!(result.error?.message?.includes('ETIMEDOUT') || result.signal === 'SIGTERM'),
  }
}

export async function executeSandboxExec(args: unknown, context: SandboxContext) {
  const normalized = normalizeToolInputArgs((args ?? {}) as Record<string, unknown>)
  const language = normalized.language as string
  const code = normalized.code as string
  const timeoutSec = normalized.timeoutSec as number | undefined
  const timeout = Math.min(Math.max(timeoutSec ?? 60, 5), 300) * 1000
  const ext = EXT_MAP[language]
  const sessionId = context.sessionId ?? 'unknown'
  const cwd = context.cwd || process.cwd()

  if (language !== 'javascript' && language !== 'typescript') {
    return sandboxUnavailableError('sandbox_exec currently supports only JavaScript and TypeScript via Node.js.')
  }

  let sandboxDir: string | null = null
  try {
    sandboxDir = createSandboxDir(cwd, sessionId)
    const sandboxRoot = sandboxDir
    const scriptFile = `script.${ext}`
    fs.writeFileSync(path.join(sandboxRoot, 'package.json'), JSON.stringify({ type: 'module' }), 'utf-8')
    fs.writeFileSync(path.join(sandboxRoot, scriptFile), code, 'utf-8')

    const warnings: string[] = []
    const docker = detectDocker()
    const runtimeResult = docker.available
      ? await executeContainerNode({
          sandboxDir: sandboxRoot,
          language,
          scriptFile,
          timeout,
          context,
        }).catch((err: unknown) => {
          warnings.push(err instanceof Error ? err.message : 'Container sandbox unavailable; used host Node fallback.')
          return executeHostNode({
            sandboxDir: sandboxRoot,
            language,
            scriptFile,
            timeout,
          })
        })
      : (() => {
          warnings.push('Docker is not available; used host Node fallback.')
          return executeHostNode({
            sandboxDir: sandboxRoot,
            language,
            scriptFile,
            timeout,
          })
        })()

    const artifacts = collectArtifacts({
      sandboxDir: sandboxRoot,
      ignoredFiles: new Set([scriptFile, 'package.json']),
    })

    return JSON.stringify({
      runtime: runtimeResult.runtime,
      exitCode: runtimeResult.exitCode,
      timedOut: runtimeResult.timedOut,
      stdout: runtimeResult.stdout,
      stderr: runtimeResult.stderr,
      artifacts,
      ...(warnings.length ? { warnings } : {}),
    })
  } catch (err: unknown) {
    return JSON.stringify({ error: err instanceof Error ? err.message : String(err) })
  } finally {
    if (sandboxDir) {
      try { fs.rmSync(sandboxDir, { recursive: true, force: true }) } catch { /* ignore */ }
    }
  }
}

export async function executeListRuntimes(context: SandboxContext) {
  const docker = detectDocker()
  const session = context.resolveCurrentSession?.() ?? null
  const status = resolveSandboxRuntimeStatus({
    config: context.config,
    session,
    agentId: context.agentId ?? session?.agentId ?? null,
    sessionId: context.sessionId ?? session?.id ?? null,
  })

  return JSON.stringify({
    node: {
      available: true,
      version: process.version,
      supportsTypeScript: true,
    },
    docker,
    sandbox: {
      enabledByConfig: Boolean(context.config?.enabled),
      sandboxedForSession: status.sandboxed,
      mode: status.mode,
      scope: status.scope,
      scopeKey: status.scopeKey,
      executionMode: docker.available && status.sandboxed ? 'container' : 'host',
      browserEnabledByConfig: context.config?.browser?.enabled === true,
    },
    guidance: docker.available
      ? []
      : ['Install Docker Desktop to keep shell, browser, and sandbox_exec inside containers.'],
  })
}

// Execution functions (executeSandboxExec, executeListRuntimes) are kept for shell.ts to import.
