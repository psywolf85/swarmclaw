import { cleanText } from '@/lib/server/text-normalization'
import type { SessionWorkingState } from '@/types'

// ---------------------------------------------------------------------------
// buildWorkingStatePromptBlock
// ---------------------------------------------------------------------------

function buildListSection(title: string, values: string[]): string | null {
  if (values.length === 0) return null
  return [title, ...values.map((value) => `- ${value}`)].join('\n')
}

export function buildWorkingStatePromptBlockFromState(
  state: SessionWorkingState | null,
): string {
  if (!state) return ''
  const activePlan = state.planSteps
    .filter((item) => item.status === 'active')
    .map((item) => item.text)
    .slice(0, 8)
  const confirmedFacts = state.confirmedFacts
    .filter((item) => item.status === 'active')
    .map((item) => item.statement)
    .slice(0, 8)
  const blockers = state.blockers
    .filter((item) => item.status === 'active')
    .map((item) => item.nextAction ? `${item.summary} | next: ${item.nextAction}` : item.summary)
    .slice(0, 6)
  const questions = state.openQuestions
    .filter((item) => item.status === 'active')
    .map((item) => item.question)
    .slice(0, 6)
  const hypotheses = state.hypotheses
    .filter((item) => item.status === 'active')
    .map((item) => item.confidence ? `${item.statement} (${item.confidence})` : item.statement)
    .slice(0, 6)
  const artifacts = state.artifacts
    .filter((item) => item.status === 'active')
    .map((item) => cleanText(item.path || item.url || item.label, 220))
    .slice(0, 6)

  const sections = [
    '## Active Working State',
    state.objective ? `Objective: ${state.objective}` : '',
    state.summary ? `Summary: ${state.summary}` : '',
    `Status: ${state.status}`,
    state.nextAction ? `Next action: ${state.nextAction}` : '',
    state.successCriteria.length > 0 ? `Success criteria: ${state.successCriteria.join(' | ')}` : '',
    state.constraints.length > 0 ? `Constraints: ${state.constraints.join(' | ')}` : '',
    buildListSection('Plan', activePlan),
    buildListSection('Confirmed facts', confirmedFacts),
    buildListSection('Blockers', blockers),
    buildListSection('Open questions', questions),
    buildListSection('Hypotheses', hypotheses),
    buildListSection('Artifacts', artifacts),
    'Trust this structured state before reconstructing status from the raw transcript.',
  ].filter(Boolean)

  return sections.join('\n')
}
