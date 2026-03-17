import { NextResponse } from 'next/server'

import { loadLearnedSkill, upsertLearnedSkill, deleteLearnedSkill } from '@/lib/server/storage'
import { notify } from '@/lib/server/ws-hub'

export const dynamic = 'force-dynamic'

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const url = new URL(req.url)
  const action = url.searchParams.get('action')

  const skill = loadLearnedSkill(id)
  if (!skill) {
    return NextResponse.json({ error: 'Learned skill not found' }, { status: 404 })
  }

  if (action === 'promote') {
    if (skill.lifecycle !== 'review_ready') {
      return NextResponse.json(
        { error: 'Only review_ready skills can be promoted' },
        { status: 400 },
      )
    }

    // Demote parent first — if this fails, child stays unpromoted (safe)
    if (skill.parentSkillId) {
      const parent = loadLearnedSkill(skill.parentSkillId)
      if (parent && parent.lifecycle === 'active') {
        parent.lifecycle = 'demoted'
        parent.demotedAt = Date.now()
        parent.demotionReason = 'Replaced by promoted revision'
        parent.updatedAt = Date.now()
        upsertLearnedSkill(parent.id, parent)
      }
    }

    skill.lifecycle = 'active'
    skill.activationCount = (skill.activationCount ?? 0) + 1
    skill.reviewReadyAt = null
    skill.updatedAt = Date.now()
    upsertLearnedSkill(id, skill)

    notify('learned_skills')
    return NextResponse.json(skill)
  }

  if (action === 'dismiss') {
    let reason: string | null = null
    try {
      const body = await req.json()
      if (body && typeof body.reason === 'string') {
        reason = body.reason
      }
    } catch {
      // no body or invalid JSON — reason stays null
    }

    skill.lifecycle = 'demoted'
    skill.demotedAt = Date.now()
    skill.demotionReason = reason ?? 'Dismissed by user'
    skill.updatedAt = Date.now()
    upsertLearnedSkill(id, skill)

    notify('learned_skills')
    return NextResponse.json(skill)
  }

  return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 })
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const skill = loadLearnedSkill(id)
  if (!skill) {
    return NextResponse.json({ error: 'Learned skill not found' }, { status: 404 })
  }

  deleteLearnedSkill(id)
  notify('learned_skills')
  return NextResponse.json({ ok: true })
}
