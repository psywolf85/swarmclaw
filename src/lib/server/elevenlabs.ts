import { loadSettings } from './storage'

const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'
const DEFAULT_MODEL_ID = 'eleven_multilingual_v2'

function getErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message
  return String(err)
}

export function resolveElevenLabsConfig(voiceId?: string | null): {
  apiKey: string
  voiceId: string
} {
  const settings = loadSettings()
  const apiKey = String(settings.elevenLabsApiKey || process.env.ELEVENLABS_API_KEY || '').trim()
  if (!apiKey) {
    throw new Error('No ElevenLabs API key. Set one in Settings > Voice.')
  }

  const resolvedVoiceId = String(
    voiceId
    || settings.elevenLabsVoiceId
    || process.env.ELEVENLABS_VOICE
    || DEFAULT_VOICE_ID,
  ).trim()

  return { apiKey, voiceId: resolvedVoiceId || DEFAULT_VOICE_ID }
}

export async function synthesizeElevenLabsMp3(params: {
  text: string
  voiceId?: string | null
  stability?: number
  similarityBoost?: number
}): Promise<Buffer> {
  const text = params.text.trim()
  if (!text) throw new Error('No text provided for ElevenLabs synthesis.')

  const { apiKey, voiceId } = resolveElevenLabsConfig(params.voiceId)
  const stability = Number.isFinite(params.stability) ? Math.max(0, Math.min(1, Number(params.stability))) : 0.5
  const similarityBoost = Number.isFinite(params.similarityBoost) ? Math.max(0, Math.min(1, Number(params.similarityBoost))) : 0.75

  const apiRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text,
      model_id: DEFAULT_MODEL_ID,
      voice_settings: {
        stability,
        similarity_boost: similarityBoost,
      },
    }),
  })

  if (!apiRes.ok) {
    const errBody = await apiRes.text().catch(() => '')
    throw new Error(errBody || `ElevenLabs request failed (${apiRes.status})`)
  }

  const audioBuffer = await apiRes.arrayBuffer()
  return Buffer.from(audioBuffer)
}

export async function requestElevenLabsMp3Stream(params: {
  text: string
  voiceId?: string | null
}): Promise<Response> {
  const text = params.text.trim()
  if (!text) throw new Error('No text provided for ElevenLabs stream.')

  const { apiKey, voiceId } = resolveElevenLabsConfig(params.voiceId)
  const apiRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      Accept: 'audio/mpeg',
    },
    body: JSON.stringify({
      text: text.slice(0, 2000),
      model_id: DEFAULT_MODEL_ID,
      voice_settings: { stability: 0.5, similarity_boost: 0.75 },
      output_format: 'mp3_22050_32',
    }),
  })

  if (!apiRes.ok) {
    const errBody = await apiRes.text().catch(() => '')
    throw new Error(errBody || `ElevenLabs streaming request failed (${apiRes.status})`)
  }

  return apiRes
}

export function explainElevenLabsError(err: unknown): string {
  return getErrorMessage(err)
}
