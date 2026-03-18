import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'
import { genId } from '@/lib/id'
import { log } from '@/lib/server/logger'
import { UPLOAD_DIR } from '@/lib/server/upload-path'

const TAG = 'api-upload'

export async function POST(req: Request) {
  const filename = req.headers.get('x-filename') || 'image.png'
  const buf = Buffer.from(await req.arrayBuffer())
  const name = genId() + '-' + filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const filePath = path.join(UPLOAD_DIR, name)

  if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true })
  fs.writeFileSync(filePath, buf)
  log.info(TAG, `saved ${buf.length} bytes to ${filePath}`)

  return NextResponse.json({ path: filePath, size: buf.length, url: `/api/uploads/${name}` })
}
