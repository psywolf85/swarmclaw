import assert from 'node:assert/strict'
import test from 'node:test'

import type { Credentials, ProviderConfig, ProviderInfo } from '@/types'
import { buildAgentSelectableProviders, resolveAgentSelectableProviderCredentials } from './agent-provider-options'

test('buildAgentSelectableProviders includes enabled custom providers missing from the provider list', () => {
  const providers: ProviderInfo[] = [
    {
      id: 'openai',
      name: 'OpenAI',
      models: ['gpt-5'],
      defaultModels: ['gpt-5'],
      supportsModelDiscovery: true,
      requiresApiKey: true,
      requiresEndpoint: false,
    },
  ]
  const providerConfigs: ProviderConfig[] = [
    {
      id: 'custom-llama',
      name: 'Llama.cpp',
      type: 'custom',
      baseUrl: 'http://localhost:8080/v1',
      models: ['llama-3.1-70b'],
      requiresApiKey: false,
      credentialId: null,
      isEnabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ]

  const result = buildAgentSelectableProviders(providers, providerConfigs)
  assert.equal(result.some((provider) => provider.id === 'custom-llama'), true)
  assert.equal(result.find((provider) => provider.id === 'custom-llama')?.name, 'Llama.cpp')
  assert.equal(result.find((provider) => provider.id === 'custom-llama')?.supportsModelDiscovery, false)
})

test('buildAgentSelectableProviders prefers custom provider config metadata when ids overlap', () => {
  const providers: ProviderInfo[] = [
    {
      id: 'custom-llama',
      name: 'Stale Custom',
      models: ['old-model'],
      defaultModels: ['old-model'],
      supportsModelDiscovery: false,
      requiresApiKey: true,
      requiresEndpoint: false,
      defaultEndpoint: 'http://old.example/v1',
    },
  ]
  const providerConfigs: ProviderConfig[] = [
    {
      id: 'custom-llama',
      name: 'Fresh Custom',
      type: 'custom',
      baseUrl: 'http://localhost:8080/v1',
      models: ['llama-3.1-70b'],
      requiresApiKey: false,
      credentialId: 'cred_custom',
      isEnabled: true,
      createdAt: 1,
      updatedAt: 2,
    },
  ]

  const result = buildAgentSelectableProviders(providers, providerConfigs)
  assert.deepEqual(result, [
    {
      id: 'custom-llama',
      name: 'Fresh Custom',
      models: ['llama-3.1-70b'],
      defaultModels: ['llama-3.1-70b'],
      supportsModelDiscovery: false,
      requiresApiKey: false,
      optionalApiKey: false,
      requiresEndpoint: true,
      defaultEndpoint: 'http://localhost:8080/v1',
      credentialId: 'cred_custom',
      type: 'custom',
    },
  ])
})

test('buildAgentSelectableProviders hides built-in providers disabled in provider configs', () => {
  const providers: ProviderInfo[] = [
    {
      id: 'openai',
      name: 'OpenAI',
      models: ['gpt-5'],
      defaultModels: ['gpt-5'],
      supportsModelDiscovery: true,
      requiresApiKey: true,
      requiresEndpoint: false,
    },
    {
      id: 'anthropic',
      name: 'Anthropic',
      models: ['claude-sonnet-4-6'],
      defaultModels: ['claude-sonnet-4-6'],
      supportsModelDiscovery: true,
      requiresApiKey: true,
      requiresEndpoint: false,
    },
  ]
  const providerConfigs: ProviderConfig[] = [
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'builtin',
      baseUrl: '',
      models: [],
      requiresApiKey: true,
      credentialId: null,
      isEnabled: false,
      createdAt: 1,
      updatedAt: 1,
    },
  ]

  const result = buildAgentSelectableProviders(providers, providerConfigs)
  assert.deepEqual(result.map((provider) => provider.id), ['anthropic'])
})

test('resolveAgentSelectableProviderCredentials includes linked provider-config credentials', () => {
  const credentials: Credentials = {
    cred_custom: {
      id: 'cred_custom',
      provider: 'OpenRouter',
      name: 'OpenRouter key',
      createdAt: 1,
    },
  }
  const providerConfigs: ProviderConfig[] = [
    {
      id: 'custom-openrouter',
      name: 'OpenRouter Custom',
      type: 'custom',
      baseUrl: 'https://openrouter.ai/api/v1',
      models: ['openai/gpt-4.1'],
      requiresApiKey: true,
      credentialId: 'cred_custom',
      isEnabled: true,
      createdAt: 1,
      updatedAt: 1,
    },
  ]

  const result = resolveAgentSelectableProviderCredentials('custom-openrouter', credentials, providerConfigs)
  assert.deepEqual(result.map((credential) => credential.id), ['cred_custom'])
})
