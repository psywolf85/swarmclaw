/**
 * Connector manager — thin hub that re-exports from focused modules.
 *
 * Module-level state (the `running` Map and generation tracking) lives in
 * `runtime-state.ts` to survive HMR.  Business logic is split into:
 *   - connector-lifecycle.ts  — start/stop/repair/health/status
 *   - connector-inbound.ts   — routeMessage, debounce, chatroom routing
 *   - connector-outbound.ts  — sendConnectorMessage, dedup, follow-ups
 */

// ─── Reconnect state (re-exported for backward compat) ───────────────────────
export {
  advanceConnectorReconnectState,
  clearReconnectState,
  createConnectorReconnectState,
  getAllReconnectStates,
  getReconnectState,
  setReconnectState,
} from './reconnect-state'
export type { ConnectorReconnectState } from './reconnect-state'

// ─── Sibling helpers (re-exported for backward compat) ───────────────────────
export {
  extractEmbeddedMedia,
  formatInboundUserText,
  formatMediaLine,
  selectOutboundMediaFiles,
} from './response-media'
export {
  getConnectorReplySendOptions,
  recordConnectorOutboundDelivery,
} from './delivery'
export { isNoMessage } from './message-sentinel'

// ─── Lifecycle ───────────────────────────────────────────────────────────────
export {
  startConnector,
  stopConnector,
  repairConnector,
  stopAllConnectors,
  autoStartConnectors,
  checkConnectorHealth,
  getConnectorStatus,
  getConnectorQR,
  isConnectorAuthenticated,
  hasConnectorCredentials,
  getConnectorRecentChannelId,
  getConnectorPresence,
  getRunningInstance,
  listRunningConnectors,
  getPlatform,
  getConnectorGeneration,
  isCurrentGeneration,
} from './connector-lifecycle'

// ─── Inbound ─────────────────────────────────────────────────────────────────
export {
  routeConnectorMessageForTest,
  setStreamAgentChatForTest,
  dispatchInboundConnectorMessage,
  deliverQueuedConnectorRunResult,
} from './connector-inbound'

// ─── Outbound ────────────────────────────────────────────────────────────────
export {
  sendConnectorMessage,
  sanitizeConnectorOutboundContent,
  performConnectorMessageAction,
  scheduleConnectorFollowUp,
  registerOutboundSend,
} from './connector-outbound'
