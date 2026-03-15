import { NextResponse } from 'next/server'
import { inferExtensionPublisherSourceFromUrl } from '@/lib/extension-sources'
import { searchClawHub } from '@/lib/server/skills/clawhub-client'
import type { ExtensionCatalogSource } from '@/types'
import { errorMessage } from '@/lib/shared-utils'

export const dynamic = 'force-dynamic'

interface RegistryExtensionEntry {
  id?: string
  name?: string
  description?: string
  url?: string
  author?: string
  version?: string
  tags?: string[]
  openclaw?: boolean
  downloads?: number
}

const REGISTRY_URLS: Array<{ url: string; catalogSource: ExtensionCatalogSource }> = [
  { url: 'https://swarmclaw.ai/registry/extensions.json', catalogSource: 'swarmclaw-site' },
  { url: 'https://raw.githubusercontent.com/swarmclawai/swarmforge/main/registry.json', catalogSource: 'swarmforge' },
]
const CACHE_TTL = 5 * 60 * 1000

let cache: { data: unknown; fetchedAt: number } | null = null

function normalizeRegistryExtensionUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null
  const trimmed = url.trim()
  if (!trimmed) return null
  return trimmed
    .replace('/swarmclawai/swarmforge/master/', '/swarmclawai/swarmforge/main/')
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const query = searchParams.get('q') || ''

  const now = Date.now()
  if (!query && cache && now - cache.fetchedAt < CACHE_TTL) {
    return NextResponse.json(cache.data)
  }

  const allExtensions: Record<string, unknown>[] = []
  const registryExtensions = new Map<string, Record<string, unknown>>()

  for (const registry of REGISTRY_URLS) {
    try {
      const res = await fetch(registry.url, { cache: 'no-store' })
      if (!res.ok) continue

      const data = await res.json()
      const entries = Array.isArray(data) ? data as RegistryExtensionEntry[] : []
      const filtered = entries.filter((p) => {
        if (!p || typeof p.name !== 'string' || typeof p.description !== 'string') return false
        return !query || p.name.toLowerCase().includes(query.toLowerCase()) || p.description.toLowerCase().includes(query.toLowerCase())
      })

      for (const p of filtered) {
        const normalizedUrl = normalizeRegistryExtensionUrl(p.url) || p.url
        const id = p.id || (p.name || '').toLowerCase().replace(/[^a-z0-9]/g, '_')
        if (registryExtensions.has(id)) continue
        registryExtensions.set(id, {
          ...p,
          id,
          url: normalizedUrl,
          source: inferExtensionPublisherSourceFromUrl(normalizedUrl) || 'swarmforge',
          catalogSource: registry.catalogSource,
        })
      }
    } catch (err: unknown) {
      console.warn('[extensions-marketplace] Registry failed:', {
        registryUrl: registry.url,
        error: errorMessage(err),
      })
    }
  }

  allExtensions.push(...registryExtensions.values())

  try {
    const hubResults = await searchClawHub(query)
    allExtensions.push(...hubResults.skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      author: s.author,
      version: s.version || '1.0.0',
      url: s.url,
      source: 'clawhub',
      catalogSource: 'clawhub',
    })))
  } catch (err: unknown) {
    console.warn('[extensions-marketplace] ClawHub failed:', errorMessage(err))
  }

  allExtensions.sort((a, b) => {
    const catalogA = typeof a.catalogSource === 'string' ? a.catalogSource : ''
    const catalogB = typeof b.catalogSource === 'string' ? b.catalogSource : ''
    if (catalogA !== catalogB) return catalogA.localeCompare(catalogB)
    const nameA = typeof a.name === 'string' ? a.name : ''
    const nameB = typeof b.name === 'string' ? b.name : ''
    return nameA.localeCompare(nameB)
  })

  if (!query) {
    cache = { data: allExtensions, fetchedAt: now }
  }

  return NextResponse.json(allExtensions)
}
