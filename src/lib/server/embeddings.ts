import { resolveCredentialSecret } from './credentials/credential-service'
import { loadSettings } from './settings/settings-repository'
import { hmrSingleton } from '@/lib/shared-utils'
import { log } from '@/lib/server/logger'

const TAG = 'embeddings'

interface PipelineState {
  instance: unknown
  loading: Promise<unknown> | null
}

const pipelineState = hmrSingleton<PipelineState>('__swarmclaw_embedding_pipeline__', () => ({
  instance: null,
  loading: null,
}))

async function getLocalPipeline(): Promise<unknown> {
  if (pipelineState.instance) return pipelineState.instance
  if (pipelineState.loading) {
    try {
      return await pipelineState.loading
    } catch {
      // Previous attempt failed — fall through to retry
    }
  }

  pipelineState.loading = (async () => {
    try {
      const { pipeline } = await import('@huggingface/transformers')
      pipelineState.instance = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', {
        dtype: 'fp32',
      })
      return pipelineState.instance
    } catch (err) {
      pipelineState.loading = null // allow retry on transient failure
      throw err
    }
  })()

  return pipelineState.loading
}

export async function getEmbedding(text: string): Promise<number[] | null> {
  const settings = loadSettings()
  const provider = settings.embeddingProvider
  if (!provider) return null

  const model = settings.embeddingModel || 'text-embedding-3-small'

  const apiKey = resolveCredentialSecret(settings.embeddingCredentialId)

  try {
    if (provider === 'local') {
      return await localEmbed(text)
    } else if (provider === 'openai') {
      return await openaiEmbed(text, model, apiKey)
    } else if (provider === 'ollama') {
      return await ollamaEmbed(text, model, settings.embeddingEndpoint)
    }
  } catch (err: unknown) {
    log.error(TAG, 'Error computing embedding:', err instanceof Error ? err.message : String(err))
  }

  return null
}

async function localEmbed(text: string): Promise<number[]> {
  const pipe = await getLocalPipeline() as (input: string, opts: Record<string, unknown>) => Promise<{ data: Float32Array }>
  const output = await pipe(text.slice(0, 8000), { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}

async function openaiEmbed(text: string, model: string, apiKey: string | null): Promise<number[]> {
  if (!apiKey) throw new Error('OpenAI API key required for embeddings')
  const res = await fetch('https://api.openai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      input: text.slice(0, 8000),
    }),
  })
  if (!res.ok) throw new Error(`OpenAI embeddings API error: ${res.status}`)
  const data = await res.json()
  return data.data[0].embedding
}

async function ollamaEmbed(text: string, model: string, endpoint?: string | null): Promise<number[]> {
  const baseUrl = endpoint || 'http://localhost:11434'
  const res = await fetch(`${baseUrl}/api/embeddings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      prompt: text.slice(0, 8000),
    }),
  })
  if (!res.ok) throw new Error(`Ollama embeddings API error: ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data?.embedding)) throw new Error('Unexpected Ollama embeddings response shape')
  return data.embedding
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dotProduct = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dotProduct / denom
}

export function serializeEmbedding(embedding: number[]): Buffer {
  return Buffer.from(new Float32Array(embedding).buffer)
}

export function deserializeEmbedding(buf: Buffer): number[] {
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4))
}
