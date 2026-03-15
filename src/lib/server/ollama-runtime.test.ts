import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveOllamaRuntimeConfig } from './ollama-runtime'

test('resolveOllamaRuntimeConfig keeps explicit local mode local with a credential and :cloud model name', () => {
  const runtime = resolveOllamaRuntimeConfig({
    model: 'glm-5:cloud',
    ollamaMode: 'local',
    apiKey: 'real-cloud-key',
    apiEndpoint: null,
  })

  assert.equal(runtime.useCloud, false)
  assert.equal(runtime.model, 'glm-5:cloud')
  assert.equal(runtime.apiKey, null)
  assert.equal(runtime.endpoint, 'http://localhost:11434')
})

test('resolveOllamaRuntimeConfig uses cloud mode only when explicitly selected', () => {
  const runtime = resolveOllamaRuntimeConfig({
    model: 'glm-5:cloud',
    ollamaMode: 'cloud',
    apiKey: 'real-cloud-key',
    apiEndpoint: 'http://localhost:11434',
  })

  assert.equal(runtime.useCloud, true)
  assert.equal(runtime.model, 'glm-5')
  assert.equal(runtime.apiKey, 'real-cloud-key')
  assert.equal(runtime.endpoint, 'https://ollama.com')
})

test('resolveOllamaRuntimeConfig falls back to endpoint-only inference for legacy records', () => {
  const runtime = resolveOllamaRuntimeConfig({
    model: 'glm-5:cloud',
    apiEndpoint: 'https://ollama.com',
  })

  assert.equal(runtime.useCloud, true)
  assert.equal(runtime.endpoint, 'https://ollama.com')
})
