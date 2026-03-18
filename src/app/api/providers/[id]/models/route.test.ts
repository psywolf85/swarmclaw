import assert from 'node:assert/strict'
import test from 'node:test'

import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('provider models route updates custom provider configs without creating model overrides', () => {
  const output = runWithTempDataDir<{
    customModels: string[]
    overrideKeys: string[]
    getPayload: { models: string[]; hasOverride: boolean }
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const routeMod = await import('./src/app/api/providers/[id]/models/route')
    const storage = storageMod.default || storageMod
    const route = routeMod.default || routeMod

    const now = Date.now()
    storage.saveProviderConfigs({
      'custom-llama': {
        id: 'custom-llama',
        name: 'Llama.cpp',
        type: 'custom',
        baseUrl: 'http://localhost:8080/v1',
        models: ['old-model'],
        requiresApiKey: false,
        credentialId: null,
        isEnabled: true,
        createdAt: now,
        updatedAt: now,
      },
    })

    await route.PUT(
      new Request('http://local/api/providers/custom-llama/models', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ models: ['llama-3.1-8b', 'llama-3.1-70b'] }),
      }),
      { params: Promise.resolve({ id: 'custom-llama' }) },
    )

    const getResponse = await route.GET(
      new Request('http://local/api/providers/custom-llama/models'),
      { params: Promise.resolve({ id: 'custom-llama' }) },
    )

    console.log(JSON.stringify({
      customModels: storage.loadProviderConfigs()['custom-llama'].models,
      overrideKeys: Object.keys(storage.loadModelOverrides()),
      getPayload: await getResponse.json(),
    }))
  `, { prefix: 'swarmclaw-provider-model-route-test-' })

  assert.deepEqual(output.customModels, ['llama-3.1-8b', 'llama-3.1-70b'])
  assert.deepEqual(output.overrideKeys, [])
  assert.deepEqual(output.getPayload, {
    models: ['llama-3.1-8b', 'llama-3.1-70b'],
    hasOverride: false,
  })
})
