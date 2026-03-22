import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let mod: typeof import('@/lib/server/chat-execution/prompt-sections')

before(async () => {
  process.env.SWARMCLAW_BUILD_MODE = '1'
  mod = await import('@/lib/server/chat-execution/prompt-sections')
})

after(() => {
  delete process.env.SWARMCLAW_BUILD_MODE
})

describe('prompt-sections', () => {
  // ---- buildIdentitySection ----
  describe('buildIdentitySection', () => {
    it('minimal mode returns short identity', () => {
      const agent = { id: 'a1', name: 'Rex' } as never
      const session = { id: 's1' } as never
      const parts = mod.buildIdentitySection(agent, session, [], true)
      assert.ok(parts.length >= 1)
      assert.ok(parts[0].includes('Rex'))
      assert.ok(parts[0].includes('My name is'))
    })

    it('returns empty array for null agent', () => {
      const parts = mod.buildIdentitySection(null, { id: 's1' } as never, [], false)
      assert.deepEqual(parts, [])
    })

    it('full mode includes description and identity directive', () => {
      const agent = { id: 'a1', name: 'Rex', description: 'A helpful agent' } as never
      const session = { id: 's1' } as never
      const parts = mod.buildIdentitySection(agent, session, [], false)
      const joined = parts.join('\n')
      assert.ok(joined.includes('A helpful agent'))
      assert.ok(joined.includes('not "Assistant"'))
    })

    it('includes soul in full mode', () => {
      const agent = { id: 'a1', name: 'Rex', soul: 'I am wise and calm.' } as never
      const session = { id: 's1' } as never
      const parts = mod.buildIdentitySection(agent, session, [], false)
      assert.ok(parts.some(p => p.includes('I am wise and calm.')))
    })

    it('truncates soul in minimal mode', () => {
      const longSoul = 'A'.repeat(500)
      const agent = { id: 'a1', name: 'Rex', soul: longSoul } as never
      const session = { id: 's1' } as never
      const parts = mod.buildIdentitySection(agent, session, [], true)
      const soulPart = parts.find(p => p.startsWith('A'))
      assert.ok(soulPart)
      assert.equal(soulPart!.length, 300)
    })

    it('includes systemPrompt', () => {
      const agent = { id: 'a1', name: 'Rex', systemPrompt: 'You are a code expert.' } as never
      const session = { id: 's1' } as never
      const parts = mod.buildIdentitySection(agent, session, [], false)
      assert.ok(parts.some(p => p.includes('You are a code expert.')))
    })
  })

  // ---- buildThinkingSection ----
  describe('buildThinkingSection', () => {
    it('returns null for minimal mode', () => {
      assert.equal(mod.buildThinkingSection('high', true), null)
    })

    it('returns null for undefined thinking level', () => {
      assert.equal(mod.buildThinkingSection(undefined, false), null)
    })

    it('returns guidance for each valid level', () => {
      for (const level of ['minimal', 'low', 'medium', 'high']) {
        const result = mod.buildThinkingSection(level, false)
        assert.ok(result, `Expected non-null for level "${level}"`)
        assert.ok(result!.includes('## Reasoning Depth'))
      }
    })

    it('returns null for unknown level', () => {
      assert.equal(mod.buildThinkingSection('extreme', false), null)
    })
  })

  describe('buildRuntimeOrientationSection', () => {
    it('includes delegated lineage, workspace markers, project context, and routing guidance', () => {
      const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'swarmclaw-runtime-orientation-'))
      try {
        fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# Agent notes')
        const result = mod.buildRuntimeOrientationSection({
          session: {
            id: 'child-session',
            cwd,
            provider: 'openai',
            model: 'gpt-5',
            parentSessionId: 'parent-session',
            agentId: 'agent-1',
          } as never,
          promptMode: 'minimal',
          sessionExtensions: ['files', 'manage_sessions', 'codex_cli'],
          toolPolicy: {
            mode: 'balanced',
            requestedExtensions: ['files', 'manage_sessions', 'codex_cli', 'manage_secrets'],
            enabledExtensions: ['files', 'manage_sessions', 'codex_cli'],
            blockedExtensions: [{ tool: 'manage_secrets', reason: 'blocked by policy', source: 'policy' }],
          },
          agent: {
            id: 'agent-1',
            name: 'Builder',
            delegationTargetMode: 'selected',
            delegationTargetAgentIds: ['qa-1', 'ops-1'],
          } as never,
          activeProjectContext: {
            projectId: 'project-1',
            project: { name: 'Northstar' },
            projectRoot: '/workspace/projects/project-1',
          } as never,
          rootSessionId: 'root-session',
        })

        assert.ok(result.includes('## Runtime Orientation'))
        assert.ok(result.includes('delegated_child'))
        assert.ok(result.includes('prompt=minimal'))
        assert.ok(result.includes('root=root-session'))
        assert.ok(result.includes('Workspace markers: AGENTS.md'))
        assert.ok(result.includes('Active project: Northstar'))
        assert.ok(result.includes('`manage_sessions`'))
        assert.ok(result.includes('`codex_cli`'))
        assert.ok(result.includes('Policy blocked:'))
        assert.ok(result.includes('sessions_tool'))
        assert.ok(result.includes('use `manage_platform` only as fallback'))
      } finally {
        fs.rmSync(cwd, { recursive: true, force: true })
      }
    })
  })

  // ---- buildProjectSection ----
  describe('buildProjectSection', () => {
    it('returns null for minimal mode', () => {
      const ctx = { projectId: 'p1', project: { name: 'Test' } } as never
      assert.equal(mod.buildProjectSection(ctx, true), null)
    })

    it('returns null when no projectId', () => {
      const ctx = { projectId: null } as never
      assert.equal(mod.buildProjectSection(ctx, false), null)
    })

    it('includes project name and description', () => {
      const ctx = {
        projectId: 'p1',
        project: { name: 'SwarmClaw', description: 'AI agent orchestration' },
        priorities: [],
        openObjectives: [],
        capabilityHints: [],
        credentialRequirements: [],
        successMetrics: [],
      } as never
      const result = mod.buildProjectSection(ctx, false)
      assert.ok(result)
      assert.ok(result!.includes('SwarmClaw'))
      assert.ok(result!.includes('AI agent orchestration'))
    })

    it('falls back to projectId when no name', () => {
      const ctx = {
        projectId: 'p-123',
        project: {},
        priorities: [],
        openObjectives: [],
        capabilityHints: [],
        credentialRequirements: [],
        successMetrics: [],
      } as never
      const result = mod.buildProjectSection(ctx, false)
      assert.ok(result!.includes('p-123'))
    })
  })

  // ---- buildSuggestionsSection ----
  describe('buildSuggestionsSection', () => {
    it('returns null when disabled', () => {
      assert.equal(mod.buildSuggestionsSection(false, false), null)
      assert.equal(mod.buildSuggestionsSection(undefined, false), null)
    })

    it('returns null in minimal mode', () => {
      assert.equal(mod.buildSuggestionsSection(true, true), null)
    })

    it('returns suggestions block when enabled', () => {
      const result = mod.buildSuggestionsSection(true, false)
      assert.ok(result)
      assert.ok(result!.includes('## Follow-up Suggestions'))
      assert.ok(result!.includes('<suggestions>'))
    })
  })

  // ---- buildCoordinatorSection ----
  describe('buildCoordinatorSection', () => {
    it('returns null for non-coordinator', () => {
      const agent = { id: 'a1', role: 'worker' } as never
      assert.equal(mod.buildCoordinatorSection(agent), null)
    })

    it('returns null for null agent', () => {
      assert.equal(mod.buildCoordinatorSection(null), null)
    })
  })
})
