import { explainElevenLabsError, requestElevenLabsMp3Stream } from '@/lib/server/elevenlabs'

export async function POST(req: Request) {
  try {
    const { text, voiceId } = await req.json()
    if (!String(text || '').trim()) {
      return new Response('No text provided', { status: 400 })
    }
    const apiRes = await requestElevenLabsMp3Stream({ text: String(text || ''), voiceId })
    return new Response(apiRes.body, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err: unknown) {
    return new Response(explainElevenLabsError(err), { status: 500 })
  }
}
