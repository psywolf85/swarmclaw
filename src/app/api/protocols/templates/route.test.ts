import assert from 'node:assert/strict'
import test from 'node:test'
import { runWithTempDataDir } from '@/lib/server/test-utils/run-with-temp-data-dir'

test('protocol template routes expose list, create, detail, update, and delete', () => {
  const output = runWithTempDataDir<{
    initialCount: number
    createdId: string | null
    fetchedName: string | null
    updatedName: string | null
    afterDeleteCount: number
  }>(`
    const listRouteMod = await import('./src/app/api/protocols/templates/route')
    const detailRouteMod = await import('./src/app/api/protocols/templates/[id]/route')
    const listRoute = listRouteMod.default || listRouteMod
    const detailRoute = detailRouteMod.default || detailRouteMod

    const initialResponse = await listRoute.GET()
    const initialPayload = await initialResponse.json()

    const createResponse = await listRoute.POST(new Request('http://local/api/protocols/templates', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Custom Review',
        description: 'A persisted custom review flow.',
        singleAgentAllowed: true,
        tags: ['custom', 'review'],
        recommendedOutputs: ['summary'],
        steps: [
          { id: 'present', kind: 'present', label: 'Open', nextStepId: 'summarize' },
          { id: 'summarize', kind: 'summarize', label: 'Summarize', nextStepId: 'complete' },
          { id: 'complete', kind: 'complete', label: 'Complete' },
        ],
        entryStepId: 'present',
      }),
    }))
    const created = await createResponse.json()

    const getResponse = await detailRoute.GET(
      new Request('http://local/api/protocols/templates/' + created.id),
      { params: Promise.resolve({ id: created.id }) },
    )
    const fetched = await getResponse.json()

    const patchResponse = await detailRoute.PATCH(
      new Request('http://local/api/protocols/templates/' + created.id, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Custom Review Updated',
          description: 'Updated custom review flow.',
          singleAgentAllowed: false,
          tags: ['updated'],
          recommendedOutputs: ['decision'],
          steps: [
            { id: 'present', kind: 'present', label: 'Open', nextStepId: 'parallel' },
            {
              id: 'parallel',
              kind: 'parallel',
              label: 'Parallel',
              nextStepId: 'join',
              parallel: {
                branches: [
                  {
                    id: 'alpha',
                    label: 'Alpha',
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
        }),
      }),
      { params: Promise.resolve({ id: created.id }) },
    )
    const updated = await patchResponse.json()

    await detailRoute.DELETE(
      new Request('http://local/api/protocols/templates/' + created.id, { method: 'DELETE' }),
      { params: Promise.resolve({ id: created.id }) },
    )

    const finalResponse = await listRoute.GET()
    const finalPayload = await finalResponse.json()

    console.log(JSON.stringify({
      initialCount: Array.isArray(initialPayload) ? initialPayload.length : -1,
      createdId: created?.id || null,
      fetchedName: fetched?.name || null,
      updatedName: updated?.name || null,
      afterDeleteCount: Array.isArray(finalPayload) ? finalPayload.filter((template) => template.id === created.id).length : -1,
    }))
  `, { prefix: 'swarmclaw-protocol-template-routes-' })

  assert.ok(output.initialCount >= 1)
  assert.ok(output.createdId)
  assert.equal(output.fetchedName, 'Custom Review')
  assert.equal(output.updatedName, 'Custom Review Updated')
  assert.equal(output.afterDeleteCount, 0)
})
