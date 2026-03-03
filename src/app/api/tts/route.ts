import { NextResponse } from 'next/server'
import { explainElevenLabsError, resolveElevenLabsConfig, synthesizeElevenLabsMp3 } from '@/lib/server/elevenlabs'

export async function POST(req: Request) {
  try {
    const { text, voiceId } = await req.json()
    if (!String(text || '').trim()) {
      return new NextResponse('No text provided', { status: 400 })
    }
    resolveElevenLabsConfig(voiceId)
    const audioBuffer = await synthesizeElevenLabsMp3({ text: String(text || ''), voiceId })
    return new NextResponse(new Uint8Array(audioBuffer), {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'no-cache',
      },
    })
  } catch (err: unknown) {
    return new NextResponse(explainElevenLabsError(err), { status: 500 })
  }
}
