import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { requestElevenLabsMp3Stream, synthesizeElevenLabsMp3 } from './elevenlabs'

describe('elevenlabs helpers', () => {
  it('synthesizeElevenLabsMp3 posts TTS request and returns audio bytes', async () => {
    const originalFetch = global.fetch
    const originalKey = process.env.ELEVENLABS_API_KEY
    const originalVoice = process.env.ELEVENLABS_VOICE
    process.env.ELEVENLABS_API_KEY = 'test-key'
    process.env.ELEVENLABS_VOICE = 'voice-123'

    let called = false
    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      called = true
      assert.equal(String(input), 'https://api.elevenlabs.io/v1/text-to-speech/voice-123')
      assert.equal(init?.method, 'POST')
      assert.equal((init?.headers as Record<string, string>)['xi-api-key'], 'test-key')
      return new Response(Buffer.from('abc'), { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }) as typeof fetch

    try {
      const out = await synthesizeElevenLabsMp3({ text: 'hello world' })
      assert.ok(called)
      assert.equal(out.toString('utf8'), 'abc')
    } finally {
      global.fetch = originalFetch
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = originalKey
      if (originalVoice === undefined) delete process.env.ELEVENLABS_VOICE
      else process.env.ELEVENLABS_VOICE = originalVoice
    }
  })

  it('requestElevenLabsMp3Stream calls streaming endpoint', async () => {
    const originalFetch = global.fetch
    const originalKey = process.env.ELEVENLABS_API_KEY
    const originalVoice = process.env.ELEVENLABS_VOICE
    process.env.ELEVENLABS_API_KEY = 'test-key'
    process.env.ELEVENLABS_VOICE = 'voice-xyz'

    global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      assert.equal(String(input), 'https://api.elevenlabs.io/v1/text-to-speech/voice-xyz/stream')
      assert.equal(init?.method, 'POST')
      return new Response('stream', { status: 200, headers: { 'Content-Type': 'audio/mpeg' } })
    }) as typeof fetch

    try {
      const res = await requestElevenLabsMp3Stream({ text: 'streaming text' })
      assert.equal(res.status, 200)
      assert.equal(await res.text(), 'stream')
    } finally {
      global.fetch = originalFetch
      if (originalKey === undefined) delete process.env.ELEVENLABS_API_KEY
      else process.env.ELEVENLABS_API_KEY = originalKey
      if (originalVoice === undefined) delete process.env.ELEVENLABS_VOICE
      else process.env.ELEVENLABS_VOICE = originalVoice
    }
  })
})
