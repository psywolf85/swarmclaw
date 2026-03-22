import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  ensureRunContext,
  dedup,
  pruneRunContext,
  foldReflectionIntoRunContext,
  buildRunContextSection,
  extractFactsFromMessages,
} from './run-context'
import type { RunContext, RunReflection, Message } from '@/types'

// ---------------------------------------------------------------------------
// ensureRunContext
// ---------------------------------------------------------------------------

test('ensureRunContext returns fresh context for null input', () => {
  const ctx = ensureRunContext(null)
  assert.equal(ctx.version, 0)
  assert.equal(ctx.objective, null)
  assert.deepEqual(ctx.keyFacts, [])
  assert.deepEqual(ctx.discoveries, [])
  assert.deepEqual(ctx.failedApproaches, [])
  assert.deepEqual(ctx.constraints, [])
  assert.deepEqual(ctx.currentPlan, [])
  assert.deepEqual(ctx.completedSteps, [])
  assert.deepEqual(ctx.blockers, [])
  assert.equal(ctx.parentContext, null)
})

test('ensureRunContext returns fresh context for undefined input', () => {
  const ctx = ensureRunContext(undefined)
  assert.equal(ctx.version, 0)
  assert.deepEqual(ctx.keyFacts, [])
})

test('ensureRunContext passes through a valid RunContext', () => {
  const existing: RunContext = {
    objective: 'Ship it',
    constraints: ['No breaking changes'],
    keyFacts: ['Fact A'],
    discoveries: [],
    failedApproaches: [],
    currentPlan: ['Step 1'],
    completedSteps: [],
    blockers: [],
    parentContext: null,
    updatedAt: 1000,
    version: 5,
  }

  const result = ensureRunContext(existing)
  assert.equal(result, existing) // same reference
  assert.equal(result.version, 5)
  assert.deepEqual(result.keyFacts, ['Fact A'])
})

test('ensureRunContext backfills missing arrays on malformed object with version', () => {
  // Simulates persisted data where some array fields were stripped/corrupted
  const malformed = { version: 3, objective: 'Fix it', updatedAt: 1 } as unknown as RunContext

  const result = ensureRunContext(malformed)
  assert.equal(result.version, 3) // preserves version
  assert.equal(result.objective, 'Fix it')
  assert.deepEqual(result.constraints, [])
  assert.deepEqual(result.keyFacts, [])
  assert.deepEqual(result.discoveries, [])
  assert.deepEqual(result.failedApproaches, [])
  assert.deepEqual(result.currentPlan, [])
  assert.deepEqual(result.completedSteps, [])
  assert.deepEqual(result.blockers, [])
})

test('ensureRunContext returns fresh context for object without version field', () => {
  const noVersion = { objective: 'Something', keyFacts: ['A'] } as unknown as RunContext
  const result = ensureRunContext(noVersion)
  assert.equal(result.version, 0)
  assert.deepEqual(result.keyFacts, [])
  assert.notEqual(result, noVersion) // new object
})

// ---------------------------------------------------------------------------
// dedup
// ---------------------------------------------------------------------------

test('dedup removes case-insensitive duplicates', () => {
  assert.deepEqual(dedup(['Hello World', 'hello world', 'HELLO WORLD']), ['Hello World'])
})

test('dedup normalizes whitespace', () => {
  assert.deepEqual(dedup(['too   many   spaces', 'too many spaces']), ['too many spaces'])
})

test('dedup filters out empty and blank strings', () => {
  assert.deepEqual(dedup(['valid', '', '   ', '\t\n', 'also valid']), ['valid', 'also valid'])
})

test('dedup preserves order of first occurrence', () => {
  assert.deepEqual(dedup(['B', 'A', 'b', 'C', 'a']), ['B', 'A', 'C'])
})

// ---------------------------------------------------------------------------
// pruneRunContext
// ---------------------------------------------------------------------------

test('pruneRunContext enforces array caps keeping most recent entries', () => {
  const ctx = ensureRunContext(null)
  // keyFacts cap is 20 — fill with 25
  ctx.keyFacts = Array.from({ length: 25 }, (_, i) => `fact-${i}`)
  // blockers cap is 8 — fill with 12
  ctx.blockers = Array.from({ length: 12 }, (_, i) => `blocker-${i}`)

  const pruned = pruneRunContext(ctx)
  assert.equal(pruned.keyFacts.length, 20)
  assert.equal(pruned.keyFacts[0], 'fact-5') // sliced from end
  assert.equal(pruned.keyFacts[19], 'fact-24')
  assert.equal(pruned.blockers.length, 8)
  assert.equal(pruned.blockers[0], 'blocker-4')
})

test('pruneRunContext leaves arrays under cap unchanged', () => {
  const ctx = ensureRunContext(null)
  ctx.keyFacts = ['a', 'b', 'c']
  const pruned = pruneRunContext(ctx)
  assert.deepEqual(pruned.keyFacts, ['a', 'b', 'c'])
})

// ---------------------------------------------------------------------------
// foldReflectionIntoRunContext
// ---------------------------------------------------------------------------

test('foldReflectionIntoRunContext creates context from null and maps reflection fields', () => {
  const reflection = {
    id: 'r1',
    runId: 'run1',
    sessionId: 's1',
    source: 'test',
    status: 'completed' as const,
    summary: 'Test reflection',
    invariantNotes: ['Invariant A'],
    lessonNotes: ['Lesson B'],
    derivedNotes: ['Derived C'],
    significantEventNotes: ['Event D'],
    failureNotes: ['Failure E'],
    openLoopNotes: ['Open loop F'],
    boundaryNotes: ['Boundary G'],
    createdAt: 1,
    updatedAt: 1,
  } satisfies Partial<RunReflection> as RunReflection

  const ctx = foldReflectionIntoRunContext(null, reflection)
  assert.equal(ctx.version, 1)
  assert.ok(ctx.keyFacts.includes('Invariant A'))
  assert.ok(ctx.keyFacts.includes('Lesson B'))
  assert.ok(ctx.discoveries.includes('Derived C'))
  assert.ok(ctx.discoveries.includes('Event D'))
  assert.ok(ctx.failedApproaches.includes('Failure E'))
  assert.ok(ctx.blockers.includes('Open loop F'))
  assert.ok(ctx.constraints.includes('Boundary G'))
})

test('foldReflectionIntoRunContext deduplicates when folding', () => {
  const existing: RunContext = {
    objective: null,
    constraints: [],
    keyFacts: ['Already known fact'],
    discoveries: [],
    failedApproaches: [],
    currentPlan: [],
    completedSteps: [],
    blockers: [],
    parentContext: null,
    updatedAt: 1,
    version: 2,
  }

  const reflection = {
    id: 'r2',
    runId: 'run2',
    sessionId: 's2',
    source: 'test',
    status: 'completed' as const,
    summary: 'Dup test',
    invariantNotes: ['already known fact'], // same content, different case
    derivedNotes: [],
    failureNotes: [],
    lessonNotes: [],
    createdAt: 1,
    updatedAt: 1,
  } satisfies Partial<RunReflection> as RunReflection

  const ctx = foldReflectionIntoRunContext(existing, reflection)
  assert.equal(ctx.keyFacts.length, 1)
  assert.equal(ctx.keyFacts[0], 'Already known fact') // keeps original casing
})

test('foldReflectionIntoRunContext increments version', () => {
  const existing = ensureRunContext(null)
  existing.version = 4

  const reflection = {
    id: 'r3',
    runId: 'run3',
    sessionId: 's3',
    source: 'test',
    status: 'completed' as const,
    summary: 'Version test',
    invariantNotes: [],
    derivedNotes: [],
    failureNotes: [],
    lessonNotes: [],
    createdAt: 1,
    updatedAt: 1,
  } satisfies Partial<RunReflection> as RunReflection

  const ctx = foldReflectionIntoRunContext(existing, reflection)
  assert.equal(ctx.version, 5)
})

// ---------------------------------------------------------------------------
// buildRunContextSection
// ---------------------------------------------------------------------------

test('buildRunContextSection returns null for null context', () => {
  assert.equal(buildRunContextSection(null, false), null)
})

test('buildRunContextSection returns null for minimal prompt', () => {
  const ctx = ensureRunContext(null)
  ctx.keyFacts = ['Something important']
  assert.equal(buildRunContextSection(ctx, true), null)
})

test('buildRunContextSection returns null for empty context', () => {
  const ctx = ensureRunContext(null)
  assert.equal(buildRunContextSection(ctx, false), null)
})

test('buildRunContextSection renders all non-empty fields', () => {
  const ctx: RunContext = {
    objective: 'Fix the pipeline',
    constraints: ['No downtime'],
    keyFacts: ['Build passes locally'],
    discoveries: ['Staging uses different auth'],
    failedApproaches: ['Restart did not help'],
    currentPlan: ['Investigate auth', 'Deploy fix'],
    completedSteps: ['Investigate auth'],
    blockers: ['Waiting on credentials'],
    parentContext: 'Coordinator wants a contained fix',
    updatedAt: 1,
    version: 3,
  }

  const section = buildRunContextSection(ctx, false)
  assert.ok(section)
  assert.match(section, /Working Memory \(RunContext\)/)
  assert.match(section, /Coordinator Context/)
  assert.match(section, /Coordinator wants a contained fix/)
  assert.match(section, /Current Objective/)
  assert.match(section, /Fix the pipeline/)
  assert.match(section, /Constraints/)
  assert.match(section, /No downtime/)
  assert.match(section, /Key Facts/)
  assert.match(section, /Build passes locally/)
  assert.match(section, /Already Tried \(Failed\)/)
  assert.match(section, /Restart did not help/)
  assert.match(section, /Current Plan/)
  assert.match(section, /Blockers/)
  assert.match(section, /Waiting on credentials/)
  assert.match(section, /Discoveries/)
  assert.match(section, /Staging uses different auth/)
})

test('buildRunContextSection renders plan with checkboxes for completed steps', () => {
  const ctx: RunContext = {
    objective: null,
    constraints: [],
    keyFacts: [],
    discoveries: [],
    failedApproaches: [],
    currentPlan: ['Step A', 'Step B', 'Step C'],
    completedSteps: ['step a', 'Step C'], // case-insensitive match
    blockers: [],
    parentContext: null,
    updatedAt: 1,
    version: 1,
  }

  const section = buildRunContextSection(ctx, false)
  assert.ok(section)
  assert.match(section, /\[x\] Step A/)
  assert.match(section, /\[ \] Step B/)
  assert.match(section, /\[x\] Step C/)
})

test('buildRunContextSection respects budget cap', () => {
  const ctx: RunContext = {
    objective: 'A'.repeat(2000),
    constraints: ['B'.repeat(2000)],
    keyFacts: ['C'.repeat(2000)],
    discoveries: [],
    failedApproaches: [],
    currentPlan: [],
    completedSteps: [],
    blockers: [],
    parentContext: null,
    updatedAt: 1,
    version: 1,
  }

  const section = buildRunContextSection(ctx, false)
  assert.ok(section)
  // The section should exist but be bounded. At 3000 char budget,
  // not all fields can fit with 2000-char values.
  assert.ok(section.length < 4000) // header + budget
})

// ---------------------------------------------------------------------------
// extractFactsFromMessages
// ---------------------------------------------------------------------------

test('extractFactsFromMessages extracts facts matching keyword patterns', () => {
  const messages = [
    { text: 'I discovered that the API key must always be rotated monthly for compliance reasons.' },
    { text: 'Note: the staging environment uses a separate auth service from production.' },
  ] as Message[]

  const result = extractFactsFromMessages(messages)
  assert.ok(result.keyFacts.length > 0)
})

test('extractFactsFromMessages categorizes error patterns as failedApproaches', () => {
  const messages = [
    { text: "The migration failed: the schema was incompatible with the target version due to column ordering." },
  ] as Message[]

  const result = extractFactsFromMessages(messages)
  assert.ok(result.failedApproaches.length > 0)
  assert.ok(result.failedApproaches.some((f) => /schema/i.test(f)))
})

test('extractFactsFromMessages deduplicates results', () => {
  const messages = [
    { text: 'Important: always validate the input before processing the request payload.' },
    { text: 'important: always validate the input before processing the request payload.' },
  ] as Message[]

  const result = extractFactsFromMessages(messages)
  // Same fact stated twice (different case) should be deduped
  const matching = result.keyFacts.filter((f) => /validate the input/i.test(f))
  assert.ok(matching.length <= 1)
})

test('extractFactsFromMessages ignores short messages', () => {
  const messages = [
    { text: 'OK' },
    { text: 'Sure, noted.' },
    { text: '' },
  ] as Message[]

  const result = extractFactsFromMessages(messages)
  assert.equal(result.keyFacts.length, 0)
  assert.equal(result.failedApproaches.length, 0)
})
