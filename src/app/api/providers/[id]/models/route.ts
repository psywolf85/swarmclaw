import { NextResponse } from 'next/server'
import { loadModelOverrides, loadProviderConfigs, saveModelOverrides, saveProviderConfigs } from '@/lib/server/storage'
import { notFound } from '@/lib/server/collection-helpers'
import { getProviderList } from '@/lib/providers'
import { safeParseBody } from '@/lib/server/safe-parse-body'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const providerConfigs = loadProviderConfigs()
  const customProvider = providerConfigs[id]
  if (customProvider?.type === 'custom') {
    return NextResponse.json({ models: customProvider.models || [], hasOverride: false })
  }

  const overrides = loadModelOverrides()
  const providers = getProviderList()
  const provider = providers.find((p) => p.id === id)
  if (!provider) return notFound()
  return NextResponse.json({ models: provider.models, hasOverride: !!overrides[id] })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const { data: body, error } = await safeParseBody<{ models?: string[] }>(req)
  if (error) return error

  const providerConfigs = loadProviderConfigs()
  const customProvider = providerConfigs[id]
  if (customProvider?.type === 'custom') {
    providerConfigs[id] = {
      ...customProvider,
      models: body.models || [],
      updatedAt: Date.now(),
    }
    saveProviderConfigs(providerConfigs)
    return NextResponse.json({ models: providerConfigs[id].models })
  }

  const overrides = loadModelOverrides()
  overrides[id] = body.models || []
  saveModelOverrides(overrides)
  return NextResponse.json({ models: overrides[id] })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const providerConfigs = loadProviderConfigs()
  const customProvider = providerConfigs[id]
  if (customProvider?.type === 'custom') {
    providerConfigs[id] = {
      ...customProvider,
      models: [],
      updatedAt: Date.now(),
    }
    saveProviderConfigs(providerConfigs)
    return NextResponse.json({ ok: true })
  }

  const overrides = loadModelOverrides()
  delete overrides[id]
  saveModelOverrides(overrides)
  return NextResponse.json({ ok: true })
}
