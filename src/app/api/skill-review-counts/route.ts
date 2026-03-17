import { NextResponse } from 'next/server'

import { listLearnedSkills } from '@/lib/server/skills/learned-skills'
import { listSkillSuggestions } from '@/lib/server/skills/skill-suggestions'

export const dynamic = 'force-dynamic'

export async function GET() {
  const suggestions = listSkillSuggestions()
  const learned = listLearnedSkills()

  const draftSuggestions = suggestions.filter((s) => s.status === 'draft').length
  const reviewReadyLearned = learned.filter((s) => s.lifecycle === 'review_ready').length

  return NextResponse.json({
    draftSuggestions,
    reviewReadyLearned,
    total: draftSuggestions + reviewReadyLearned,
  })
}
