/**
 * KeyedAsyncQueue — serialize async operations per key, parallel across keys.
 * Each key gets a serial queue; different keys run concurrently.
 */
export class KeyedAsyncQueue {
  private chains = new Map<string, Promise<void>>()

  enqueue<T>(key: string, fn: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const prev = this.chains.get(key) ?? Promise.resolve()
      const next = prev.then(async () => {
        try {
          let result: T
          if (options?.timeoutMs != null && options.timeoutMs > 0) {
            result = await withTimeout(fn(), options.timeoutMs)
          } else {
            result = await fn()
          }
          resolve(result)
        } catch (err) {
          reject(err)
        }
      })
      // Store a settled version so errors don't break the chain
      const settled = next.then(() => {}, () => {})
      this.chains.set(key, settled)
      // Cleanup when this is still the tail of the chain
      settled.then(() => {
        if (this.chains.get(key) === settled) {
          this.chains.delete(key)
        }
      })
    })
  }

  get activeKeys(): number {
    return this.chains.size
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`KeyedAsyncQueue: operation timed out after ${ms}ms`)), ms)
    promise.then(
      (val) => { clearTimeout(timer); resolve(val) },
      (err) => { clearTimeout(timer); reject(err) },
    )
  })
}
