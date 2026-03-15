import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('protocol run routes expose list, detail, events, and actions', () => {
  const output = runWithTempDataDir<{
    createdStatus: string | null
    listCount: number
    detailId: string | null
    transcriptHidden: boolean
    detailStepKinds: string[]
    eventsCount: number
    resumedStatus: string | null
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const listRouteMod = await import('./src/app/api/protocols/runs/route')
    const detailRouteMod = await import('./src/app/api/protocols/runs/[id]/route')
    const eventsRouteMod = await import('./src/app/api/protocols/runs/[id]/events/route')
    const actionsRouteMod = await import('./src/app/api/protocols/runs/[id]/actions/route')
    const storage = storageMod.default || storageMod
    const listRoute = listRouteMod.default || listRouteMod
    const detailRoute = detailRouteMod.default || detailRouteMod
    const eventsRoute = eventsRouteMod.default || eventsRouteMod
    const actionsRoute = actionsRouteMod.default || actionsRouteMod

    storage.upsertStoredItem('agents', 'agentA', {
      id: 'agentA',
      name: 'Agent A',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })

    const createResponse = await listRoute.POST(new Request('http://local/api/protocols/runs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Single agent structured run',
        templateId: 'single_agent_structured_run',
        participantAgentIds: ['agentA'],
        facilitatorAgentId: 'agentA',
        autoStart: false,
        steps: [
          { id: 'present', kind: 'present', label: 'Open', nextStepId: 'parallel' },
          {
            id: 'parallel',
            kind: 'parallel',
            label: 'Parallel work',
            nextStepId: 'join',
            parallel: {
              branches: [
                {
                  id: 'alpha',
                  label: 'Alpha branch',
                  participantAgentIds: ['agentA'],
                  steps: [
                    { id: 'alpha_open', kind: 'present', label: 'Alpha open', nextStepId: 'alpha_complete' },
                    { id: 'alpha_complete', kind: 'complete', label: 'Complete' },
                  ],
                  entryStepId: 'alpha_open',
                },
              ],
            },
          },
          { id: 'join', kind: 'join', label: 'Join', join: { parallelStepId: 'parallel' }, nextStepId: 'complete' },
          { id: 'complete', kind: 'complete', label: 'Complete' },
        ],
        entryStepId: 'present',
        config: {
          goal: 'Produce one structured response.',
        },
      }),
    }))
    const created = await createResponse.json()

    const listResponse = await listRoute.GET(new Request('http://local/api/protocols/runs?limit=5'))
    const listPayload = await listResponse.json()

    const detailResponse = await detailRoute.GET(
      new Request('http://local/api/protocols/runs/' + created.id),
      { params: Promise.resolve({ id: created.id }) },
    )
    const detailPayload = await detailResponse.json()

    const eventsResponse = await eventsRoute.GET(
      new Request('http://local/api/protocols/runs/' + created.id + '/events?limit=5'),
      { params: Promise.resolve({ id: created.id }) },
    )
    const eventsPayload = await eventsResponse.json()

    const resumeResponse = await actionsRoute.POST(
      new Request('http://local/api/protocols/runs/' + created.id + '/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action: 'resume' }),
      }),
      { params: Promise.resolve({ id: created.id }) },
    )
    const resumePayload = await resumeResponse.json()

    console.log(JSON.stringify({
      createdStatus: created?.status || null,
      listCount: Array.isArray(listPayload) ? listPayload.length : -1,
      detailId: detailPayload?.run?.id || null,
      transcriptHidden: detailPayload?.transcript?.hidden === true,
      detailStepKinds: Array.isArray(detailPayload?.run?.steps) ? detailPayload.run.steps.map((step) => step.kind) : [],
      eventsCount: Array.isArray(eventsPayload) ? eventsPayload.length : -1,
      resumedStatus: resumePayload?.run?.status || null,
    }))
  `, { prefix: 'swarmclaw-protocol-routes-' })

  assert.equal(output.createdStatus, 'draft')
  assert.equal(output.listCount, 1)
  assert.ok(output.detailId)
  assert.equal(output.transcriptHidden, true)
  assert.deepEqual(output.detailStepKinds, ['present', 'parallel', 'join', 'complete'])
  assert.equal(output.eventsCount >= 1, true)
  assert.equal(output.resumedStatus, 'running')
})

test('protocol run routes support parent chatroom filtering for linked live rooms', () => {
  const output = runWithTempDataDir<{
    parentChatroomCount: number
    unrelatedCount: number
  }>(`
    const storageMod = await import('./src/lib/server/storage')
    const protocolsMod = await import('./src/lib/server/protocols/protocol-service')
    const listRouteMod = await import('./src/app/api/protocols/runs/route')
    const storage = storageMod.default || storageMod
    const protocols = protocolsMod.default || protocolsMod
    const listRoute = listRouteMod.default || listRouteMod

    storage.upsertStoredItem('agents', 'agentA', {
      id: 'agentA',
      name: 'Agent A',
      provider: 'ollama',
      model: 'test-model',
      systemPrompt: 'test',
      createdAt: 1,
      updatedAt: 1,
    })

    protocols.createProtocolRun({
      title: 'Room linked run',
      participantAgentIds: ['agentA'],
      facilitatorAgentId: 'agentA',
      parentChatroomId: 'room-1',
      autoStart: false,
    })

    protocols.createProtocolRun({
      title: 'Unrelated run',
      participantAgentIds: ['agentA'],
      facilitatorAgentId: 'agentA',
      autoStart: false,
    })

    const parentChatroomResponse = await listRoute.GET(new Request('http://local/api/protocols/runs?parentChatroomId=room-1&limit=5'))
    const unrelatedResponse = await listRoute.GET(new Request('http://local/api/protocols/runs?parentChatroomId=room-2&limit=5'))
    const parentChatroomPayload = await parentChatroomResponse.json()
    const unrelatedPayload = await unrelatedResponse.json()

    console.log(JSON.stringify({
      parentChatroomCount: Array.isArray(parentChatroomPayload) ? parentChatroomPayload.length : -1,
      unrelatedCount: Array.isArray(unrelatedPayload) ? unrelatedPayload.length : -1,
    }))
  `, { prefix: 'swarmclaw-protocol-room-filter-' })

  assert.equal(output.parentChatroomCount, 1)
  assert.equal(output.unrelatedCount, 0)
})
