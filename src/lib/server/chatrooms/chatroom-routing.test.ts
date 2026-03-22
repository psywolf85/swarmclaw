import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Agent, Chatroom } from '@/types'
import {
  ensureChatroomRoutingGuidance,
  selectChatroomRecipients,
  synthesizeRoutingGuidanceFromRules,
} from './chatroom-routing'

const agents: Record<string, Agent> = {
  ops: {
    id: 'ops',
    name: 'Ops',
    description: 'Handles deploys and infrastructure',
    provider: 'openai',
    model: 'gpt-test',
    systemPrompt: '',
    capabilities: ['deploy', 'infrastructure'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
  design: {
    id: 'design',
    name: 'Design',
    description: 'Handles design critique and UI polish',
    provider: 'openai',
    model: 'gpt-test',
    systemPrompt: '',
    capabilities: ['design', 'ui'],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  },
}

function makeChatroom(overrides: Partial<Chatroom> = {}): Chatroom {
  return {
    id: 'room-1',
    name: 'Test Room',
    description: 'General routing test room',
    agentIds: ['ops', 'design'],
    messages: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  }
}

test('synthesizes guidance from legacy routing rules and migrates the chatroom', () => {
  const chatroom = makeChatroom({
    routingRules: [
      { id: 'rule-1', type: 'keyword', keywords: ['deploy', 'release'], agentId: 'ops', priority: 1 },
      { id: 'rule-2', type: 'capability', pattern: 'design review', agentId: 'design', priority: 2 },
    ],
  })

  const guidance = synthesizeRoutingGuidanceFromRules(chatroom.routingRules, agents)
  assert.match(String(guidance || ''), /deploy/i)
  assert.match(String(guidance || ''), /Design/i)

  const changed = ensureChatroomRoutingGuidance(chatroom, agents)
  assert.equal(changed, true)
  assert.equal(typeof chatroom.routingGuidance, 'string')
  assert.equal(chatroom.routingRules, undefined)
})

test('selects only member ids returned by the selector model', async () => {
  const chatroom = makeChatroom({
    routingGuidance: 'Route deployment incidents to Ops. Prefer Design for UI critique.',
  })

  const selected = await selectChatroomRecipients({
    text: 'Please diagnose the failed deployment.',
    chatroom,
    agentsById: agents,
  }, {
    generateText: async () => '{"agentIds":["ops","non-member","ops"]}',
  })

  assert.deepEqual(selected, ['ops'])
})

test('fails open to no inferred mentions when there is no guidance or the selector output is invalid', async () => {
  const unguided = await selectChatroomRecipients({
    text: 'Anyone here?',
    chatroom: makeChatroom(),
    agentsById: agents,
  }, {
    generateText: async () => '{"agentIds":["ops"]}',
  })
  assert.deepEqual(unguided, [])

  const invalid = await selectChatroomRecipients({
    text: 'Please review the new layout.',
    chatroom: makeChatroom({ routingGuidance: 'Prefer Design for UI review.' }),
    agentsById: agents,
  }, {
    generateText: async () => 'not-json',
  })
  assert.deepEqual(invalid, [])
})
