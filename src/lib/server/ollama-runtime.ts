import { stripOllamaCloudModelSuffix } from '@/lib/ollama-model'
import { isOllamaCloudEndpoint, resolveStoredOllamaMode } from '@/lib/ollama-mode'
import { PROVIDER_DEFAULTS } from '@/lib/providers/provider-defaults'

const OLLAMA_CLOUD_KEY_ENV_VARS = ['OLLAMA_API_KEY', 'OLLAMA_CLOUD_API_KEY'] as const

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function resolveOllamaCloudApiKey(explicitApiKey?: string | null): string | null {
  const explicit = clean(explicitApiKey)
  if (explicit && explicit !== 'ollama') return explicit
  for (const envName of OLLAMA_CLOUD_KEY_ENV_VARS) {
    const candidate = clean(process.env[envName])
    if (candidate) return candidate
  }
  return null
}

export function resolveOllamaRuntimeConfig(input: {
  model?: string | null
  ollamaMode?: string | null
  apiKey?: string | null
  apiEndpoint?: string | null
}): {
  model: string
  useCloud: boolean
  apiKey: string | null
  endpoint: string
} {
  const rawModel = clean(input.model) || ''
  const explicitApiKey = clean(input.apiKey)
  const explicitEndpoint = clean(input.apiEndpoint)
  const ollamaMode = resolveStoredOllamaMode({
    ollamaMode: input.ollamaMode ?? null,
    apiEndpoint: explicitEndpoint,
  })
  const cloudApiKey = resolveOllamaCloudApiKey(explicitApiKey)
  const useCloud = ollamaMode === 'cloud'
  const endpoint = useCloud
    ? (isOllamaCloudEndpoint(explicitEndpoint) ? explicitEndpoint! : PROVIDER_DEFAULTS.ollamaCloud)
    : (explicitEndpoint && !isOllamaCloudEndpoint(explicitEndpoint) ? explicitEndpoint : PROVIDER_DEFAULTS.ollama)

  return {
    model: useCloud ? (stripOllamaCloudModelSuffix(rawModel) || rawModel) : rawModel,
    useCloud,
    apiKey: useCloud ? cloudApiKey : null,
    endpoint,
  }
}
