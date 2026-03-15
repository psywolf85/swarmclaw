import { NextResponse } from 'next/server'
import { getExtensionManager } from '@/lib/server/extensions'
import '@/lib/server/builtin-extensions'

export const dynamic = 'force-dynamic'

/**
 * Returns the set of all known builtin extension IDs and which are enabled.
 * Also returns tool names from enabled external extensions.
 * Used by the UI to hide/grey-out tools whose backing extension is disabled.
 */
export async function GET() {
  const manager = getExtensionManager()
  const all = manager.listExtensions()

  // Set of extension IDs (both builtin and external) that are currently enabled
  const enabledExtensionIds = all
    .filter((p) => p.enabled)
    .map((p) => p.filename)

  // For external extensions that are enabled, also collect their concrete tool names
  // so the UI can show those tools in the toggles
  const externalTools: Array<{ extensionId: string; toolName: string; label: string; description: string }> = []
  for (const meta of all) {
    if (meta.isBuiltin || !meta.enabled) continue
    try {
      const tools = manager.getTools([meta.filename])
      for (const entry of tools) {
        externalTools.push({
          extensionId: entry.extensionId,
          toolName: entry.tool.name,
          label: entry.tool.name.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
          description: entry.tool.description || '',
        })
      }
    } catch { /* ignore load failures */ }
  }

  return NextResponse.json({ enabledExtensionIds, externalTools })
}
