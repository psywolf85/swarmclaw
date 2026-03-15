import type {
  ExtensionCatalogSource,
  ExtensionInstallSource,
  ExtensionPublisherSource,
} from '@/types'

const PUBLISHER_SOURCES = ['builtin', 'local', 'manual', 'swarmclaw', 'swarmforge', 'clawhub'] as const
const CATALOG_SOURCES = ['swarmclaw', 'swarmclaw-site', 'swarmforge', 'clawhub'] as const
const INSTALL_SOURCES = ['builtin', 'local', 'manual', ...CATALOG_SOURCES] as const

const SOURCE_LABELS: Record<ExtensionInstallSource | ExtensionPublisherSource, string> = {
  builtin: 'Built-in',
  local: 'Local file',
  manual: 'Manual URL',
  swarmclaw: 'SwarmClaw',
  'swarmclaw-site': 'SwarmClaw Site',
  swarmforge: 'SwarmForge',
  clawhub: 'ClawHub',
}

export function normalizeExtensionPublisherSource(raw: unknown): ExtensionPublisherSource | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value) return undefined
  return (PUBLISHER_SOURCES as readonly string[]).includes(value)
    ? value as ExtensionPublisherSource
    : undefined
}

export function normalizeExtensionCatalogSource(raw: unknown): ExtensionCatalogSource | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value) return undefined
  return (CATALOG_SOURCES as readonly string[]).includes(value)
    ? value as ExtensionCatalogSource
    : undefined
}

export function normalizeExtensionInstallSource(raw: unknown): ExtensionInstallSource | undefined {
  const value = typeof raw === 'string' ? raw.trim().toLowerCase() : ''
  if (!value) return undefined
  return (INSTALL_SOURCES as readonly string[]).includes(value)
    ? value as ExtensionInstallSource
    : undefined
}

export function inferExtensionPublisherSourceFromUrl(url: string | null | undefined): ExtensionPublisherSource | undefined {
  const normalized = typeof url === 'string' ? url.trim().toLowerCase() : ''
  if (!normalized) return undefined
  if (normalized.includes('clawhub.ai')) return 'clawhub'
  if (normalized.includes('swarmclaw.ai/')) return 'swarmclaw'
  if (
    normalized.includes('raw.githubusercontent.com/swarmclawai/swarmforge/')
    || normalized.includes('github.com/swarmclawai/swarmforge/')
    || normalized.includes('/swarmclawai/extensions/')
  ) {
    return 'swarmforge'
  }
  return undefined
}

export function inferExtensionInstallSourceFromUrl(url: string | null | undefined): ExtensionInstallSource | undefined {
  const publisherSource = inferExtensionPublisherSourceFromUrl(url)
  if (publisherSource === 'swarmclaw' || publisherSource === 'swarmforge' || publisherSource === 'clawhub') {
    return publisherSource
  }
  return undefined
}

export function isMarketplaceInstallSource(source: ExtensionInstallSource | null | undefined): boolean {
  return source === 'swarmclaw' || source === 'swarmclaw-site' || source === 'swarmforge' || source === 'clawhub'
}

export function getExtensionSourceLabel(
  source: ExtensionInstallSource | ExtensionPublisherSource | ExtensionCatalogSource | null | undefined,
): string {
  if (!source) return 'Unknown'
  return SOURCE_LABELS[source as keyof typeof SOURCE_LABELS] || source
}
