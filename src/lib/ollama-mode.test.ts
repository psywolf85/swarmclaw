import assert from 'node:assert/strict'
import test from 'node:test'
import { isOllamaCloudEndpoint, normalizeOllamaMode, resolveStoredOllamaMode } from './ollama-mode'

test('normalizeOllamaMode only accepts explicit local and cloud values', () => {
  assert.equal(normalizeOllamaMode('local'), 'local')
  assert.equal(normalizeOllamaMode('cloud'), 'cloud')
  assert.equal(normalizeOllamaMode(''), null)
  assert.equal(normalizeOllamaMode('something-else'), null)
})

test('isOllamaCloudEndpoint recognizes Ollama Cloud URLs', () => {
  assert.equal(isOllamaCloudEndpoint('https://ollama.com'), true)
  assert.equal(isOllamaCloudEndpoint('https://api.ollama.com/v1'), true)
  assert.equal(isOllamaCloudEndpoint('http://localhost:11434'), false)
})

test('resolveStoredOllamaMode prefers explicit mode over endpoint inference', () => {
  assert.equal(resolveStoredOllamaMode({
    ollamaMode: 'local',
    apiEndpoint: 'https://ollama.com',
  }), 'local')
  assert.equal(resolveStoredOllamaMode({
    ollamaMode: 'cloud',
    apiEndpoint: 'http://localhost:11434',
  }), 'cloud')
})

test('resolveStoredOllamaMode falls back to endpoint only for legacy records', () => {
  assert.equal(resolveStoredOllamaMode({ apiEndpoint: 'https://ollama.com' }), 'cloud')
  assert.equal(resolveStoredOllamaMode({ apiEndpoint: 'http://localhost:11434' }), 'local')
  assert.equal(resolveStoredOllamaMode({}), 'local')
})
