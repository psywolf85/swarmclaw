import { hmrSingleton } from '@/lib/shared-utils'
import { log } from '@/lib/server/logger'

const debugState = hmrSingleton('__swarmclaw_debug__', () => ({
  enabled: process.env.SWARMCLAW_DEBUG === '1',
}))

export const debug = {
  get enabled() { return debugState.enabled },
  setEnabled(v: boolean) { debugState.enabled = v },
  log(tag: string, msg: string, data?: unknown) {
    if (!debugState.enabled) return
    log.debug(tag, msg, data)
  },
  /** Full payloads — only in debug mode, auto-truncated by logger */
  verbose(tag: string, msg: string, data?: unknown) {
    if (!debugState.enabled) return
    log.debug(tag, msg, data)
  },
}
