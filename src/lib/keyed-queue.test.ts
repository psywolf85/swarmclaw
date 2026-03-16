import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { KeyedAsyncQueue } from './keyed-queue'

describe('KeyedAsyncQueue', () => {
  it('serializes tasks within the same key', async () => {
    const queue = new KeyedAsyncQueue()
    const order: number[] = []
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

    const p1 = queue.enqueue('a', async () => { await delay(30); order.push(1) })
    const p2 = queue.enqueue('a', async () => { order.push(2) })
    await Promise.all([p1, p2])
    assert.deepEqual(order, [1, 2])
  })

  it('runs different keys in parallel', async () => {
    const queue = new KeyedAsyncQueue()
    const order: string[] = []
    const delay = (ms: number) => new Promise(r => setTimeout(r, ms))

    const p1 = queue.enqueue('a', async () => { await delay(30); order.push('a') })
    const p2 = queue.enqueue('b', async () => { order.push('b') })
    await Promise.all([p1, p2])
    assert.deepEqual(order, ['b', 'a'])
  })

  it('isolates errors between tasks', async () => {
    const queue = new KeyedAsyncQueue()
    const p1 = queue.enqueue('a', async () => { throw new Error('fail') })
    const p2 = queue.enqueue('a', async () => 'ok')
    await assert.rejects(p1, /fail/)
    assert.equal(await p2, 'ok')
  })

  it('cleans up keys when queue drains', async () => {
    const queue = new KeyedAsyncQueue()
    assert.equal(queue.activeKeys, 0)
    const p = queue.enqueue('x', async () => 42)
    assert.equal(queue.activeKeys, 1)
    await p
    // Allow microtask for cleanup
    await new Promise(r => setTimeout(r, 0))
    assert.equal(queue.activeKeys, 0)
  })

  it('returns the value produced by the enqueued function', async () => {
    const queue = new KeyedAsyncQueue()
    const result = await queue.enqueue('k', async () => 'hello')
    assert.equal(result, 'hello')
  })
})
