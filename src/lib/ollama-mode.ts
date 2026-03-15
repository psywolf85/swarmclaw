export type OllamaMode = 'local' | 'cloud'

function clean(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function normalizeOllamaMode(value: string | null | undefined): OllamaMode | null {
  const normalized = clean(value)
  if (normalized === 'local' || normalized === 'cloud') return normalized
  return null
}

export function isOllamaCloudEndpoint(endpoint: string | null | undefined): boolean {
  const normalized = clean(endpoint)
  if (!normalized) return false
  return /^https?:\/\/(?:www\.|api\.)?ollama\.com(?:\/|$)/i.test(normalized)
}

export function resolveStoredOllamaMode(input: {
  ollamaMode?: string | null
  apiEndpoint?: string | null
}): OllamaMode {
  const explicitMode = normalizeOllamaMode(input.ollamaMode)
  if (explicitMode) return explicitMode
  return isOllamaCloudEndpoint(input.apiEndpoint) ? 'cloud' : 'local'
}
