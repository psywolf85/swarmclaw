import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('custom providers resolve from saved provider configs', () => {
  const output = runWithTempDataDir<{
    providerIds: string[]
    supportsModelDiscovery: boolean | null
    resolvedProviderName: string | null
    hasHandler: boolean
  }>(`
    const storageModule = await import('@/lib/server/storage')
    const storage = storageModule.default || storageModule
    storage.saveProviderConfigs({
      'custom-llama': {
        id: 'custom-llama',
        name: 'Llama.cpp',
        type: 'custom',
        baseUrl: 'http://127.0.0.1:8080/v1',
        models: ['llama-3.1-8b'],
        requiresApiKey: false,
        credentialId: null,
        isEnabled: true,
        createdAt: 1,
        updatedAt: 1,
      },
    })

    const providersModule = await import('@/lib/providers/index')
    const providers = providersModule.default || providersModule
    const providerList = providers.getProviderList()
    const resolvedProvider = providers.getProvider('custom-llama')

    console.log(JSON.stringify({
      providerIds: providerList.map((provider) => provider.id),
      supportsModelDiscovery: providerList.find((provider) => provider.id === 'custom-llama')?.supportsModelDiscovery ?? null,
      resolvedProviderName: resolvedProvider?.name ?? null,
      hasHandler: typeof resolvedProvider?.handler?.streamChat === 'function',
    }))
  `)

  assert.equal(output.providerIds.includes('custom-llama'), true)
  assert.equal(output.supportsModelDiscovery, false)
  assert.equal(output.resolvedProviderName, 'Llama.cpp')
  assert.equal(output.hasHandler, true)
})

test('builtin provider override records do not surface as custom providers', () => {
  const output = runWithTempDataDir<{ openAiCount: number }>(`
    const storageModule = await import('@/lib/server/storage')
    const storage = storageModule.default || storageModule
    storage.saveProviderConfigs({
      openai: {
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
    })

    const providersModule = await import('@/lib/providers/index')
    const providers = providersModule.default || providersModule
    const providerList = providers.getProviderList()

    console.log(JSON.stringify({
      openAiCount: providerList.filter((provider) => provider.id === 'openai').length,
    }))
  `)

  assert.equal(output.openAiCount, 1)
})
