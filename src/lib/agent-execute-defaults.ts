import type { Agent } from '@/types'

export type AgentExecuteConfig = NonNullable<Agent['executeConfig']>

export const DEFAULT_AGENT_EXECUTE_CONFIG: AgentExecuteConfig = {
  backend: 'sandbox',
  network: {
    enabled: true,
  },
  timeout: 30,
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function normalizeStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim())
  return values.length > 0 ? values : undefined
}

function normalizePositiveInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === 'number'
    ? value
    : typeof value === 'string'
      ? Number.parseInt(value, 10)
      : Number.NaN
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, Math.trunc(parsed)))
}

export function normalizeAgentExecuteConfig(config: Agent['executeConfig'] | unknown): AgentExecuteConfig {
  const input = asRecord(config)
  const networkInput = asRecord(input?.network)
  const runtimesInput = asRecord(input?.runtimes)
  const defaultNetworkEnabled = DEFAULT_AGENT_EXECUTE_CONFIG.network?.enabled ?? true
  const allowedUrls = normalizeStringList(networkInput?.allowedUrls)
  const credentials = normalizeStringList(input?.credentials)

  return {
    backend: input?.backend === 'host' ? 'host' : DEFAULT_AGENT_EXECUTE_CONFIG.backend,
    network: {
      enabled: networkInput?.enabled === false ? false : defaultNetworkEnabled,
      ...(allowedUrls ? { allowedUrls } : {}),
    },
    ...(runtimesInput
      ? {
          runtimes: {
            ...(typeof runtimesInput.python === 'boolean' ? { python: runtimesInput.python } : {}),
            ...(typeof runtimesInput.javascript === 'boolean' ? { javascript: runtimesInput.javascript } : {}),
            ...(typeof runtimesInput.sqlite === 'boolean' ? { sqlite: runtimesInput.sqlite } : {}),
          },
        }
      : {}),
    timeout: normalizePositiveInt(input?.timeout, DEFAULT_AGENT_EXECUTE_CONFIG.timeout ?? 30, 1, 300),
    ...(credentials ? { credentials } : {}),
  }
}
