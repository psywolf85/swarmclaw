import fs from 'fs'
import path from 'path'
import { UPLOAD_DIR } from './storage'

const UPLOAD_URL_PREFIX = '/api/uploads/'

function resolveUploadBackedPath(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null

  let candidate = trimmed
  if (candidate.startsWith('sandbox:')) {
    candidate = candidate.slice('sandbox:'.length)
  }

  if (/^https?:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).pathname
    } catch {
      return null
    }
  } else if (/^file:\/\//i.test(candidate)) {
    try {
      candidate = new URL(candidate).pathname
    } catch {
      candidate = candidate.replace(/^file:\/\//i, '')
    }
  }

  if (!candidate.startsWith(UPLOAD_URL_PREFIX)) return null

  const filename = candidate.slice(UPLOAD_URL_PREFIX.length)
  let decoded = filename
  try { decoded = decodeURIComponent(filename) } catch { /* keep raw filename */ }
  const safeName = path.basename(decoded).replace(/[^a-zA-Z0-9._-]/g, '')
  if (!safeName) return null

  const resolved = path.join(UPLOAD_DIR, safeName)
  return fs.existsSync(resolved) ? resolved : null
}

/**
 * Resolve an image to a valid filesystem path.
 *
 * Tries, in order:
 *   1. `imagePath` (the absolute filesystem path returned by the upload API)
 *   2. `imageUrl` mapped back to the uploads dir (e.g. `/api/uploads/foo.jpeg` → `UPLOAD_DIR/foo.jpeg`)
 *
 * Returns `null` if neither resolves to an existing file.
 */
export function resolveImagePath(imagePath?: string, imageUrl?: string): string | null {
  if (imagePath && fs.existsSync(imagePath)) return imagePath
  if (imagePath) {
    const resolvedFromImagePath = resolveUploadBackedPath(imagePath)
    if (resolvedFromImagePath) return resolvedFromImagePath
  }

  const resolvedFromImageUrl = imageUrl ? resolveUploadBackedPath(imageUrl) : null
  if (resolvedFromImageUrl) return resolvedFromImageUrl

  return null
}
