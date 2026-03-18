import type { Credential, Credentials, ProviderConfig, ProviderInfo } from '@/types'

export interface AgentSelectableProvider {
  id: string
  name: string
  models: string[]
  defaultModels?: string[]
  supportsModelDiscovery?: boolean
  requiresApiKey: boolean
  optionalApiKey?: boolean
  requiresEndpoint: boolean
  defaultEndpoint?: string
  credentialId?: string | null
  type: 'builtin' | 'custom'
}

function buildCustomProviderOption(config: ProviderConfig): AgentSelectableProvider {
  return {
    id: config.id,
    name: config.name || 'Custom Provider',
    models: Array.isArray(config.models) ? config.models : [],
    defaultModels: Array.isArray(config.models) ? config.models : [],
    supportsModelDiscovery: false,
    requiresApiKey: config.requiresApiKey,
    optionalApiKey: false,
    requiresEndpoint: Boolean(config.baseUrl),
    defaultEndpoint: config.baseUrl || undefined,
    credentialId: config.credentialId ?? null,
    type: 'custom',
  }
}

export function buildAgentSelectableProviders(
  providers: ProviderInfo[],
  providerConfigs: ProviderConfig[],
): AgentSelectableProvider[] {
  const disabledBuiltinIds = new Set(
    providerConfigs
      .filter((config) => config.type === 'builtin' && config.isEnabled === false)
      .map((config) => config.id),
  )

  const merged: AgentSelectableProvider[] = providers
    .filter((provider) => !disabledBuiltinIds.has(String(provider.id)))
    .map((provider) => ({
    ...provider,
    credentialId: null,
    type: 'builtin' as const,
    }))
  const indexById = new Map(merged.map((provider, index) => [provider.id, index]))

  for (const config of providerConfigs) {
    if (config.type !== 'custom' || config.isEnabled === false) continue
    const customProvider = buildCustomProviderOption(config)
    const existingIndex = indexById.get(config.id)
    if (existingIndex == null) {
      indexById.set(config.id, merged.length)
      merged.push(customProvider)
      continue
    }
    merged[existingIndex] = customProvider
  }

  return merged
}

export function resolveAgentSelectableProviderCredentials(
  providerId: string,
  credentials: Credentials,
  providerConfigs: ProviderConfig[],
): Credential[] {
  const matches = Object.values(credentials).filter((credential) => credential.provider === providerId)
  const config = providerConfigs.find((candidate) => (
    candidate.type === 'custom'
    && candidate.id === providerId
    && candidate.isEnabled !== false
  ))
  if (!config?.credentialId) return matches

  const linkedCredential = credentials[config.credentialId]
  if (!linkedCredential) return matches
  if (matches.some((credential) => credential.id === linkedCredential.id)) return matches
  return [...matches, linkedCredential]
}
