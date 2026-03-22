import type { ProviderId } from './provider'
import type { Session } from './session'
import type { Message } from './message'
import type { ApprovalRequest } from './approval'
import type { MessageToolEvent } from './message'
import type { InboundMessage, OutboundSendOptions } from './connector'

export interface ExtensionPromptBuildResult {
  systemPrompt?: string
  prependContext?: string
  prependSystemContext?: string
  appendSystemContext?: string
}

export interface ExtensionModelResolveResult {
  providerOverride?: ProviderId
  modelOverride?: string
  apiEndpointOverride?: string | null
}

export interface ExtensionToolCallResult {
  input?: Record<string, unknown> | null
  params?: Record<string, unknown>
  block?: boolean
  blockReason?: string
  warning?: string
}

export interface ExtensionMessagePersistResult {
  message?: Message
}

export interface ExtensionBeforeMessageWriteResult extends ExtensionMessagePersistResult {
  block?: boolean
}

export interface ExtensionSubagentSpawningResult {
  status: 'ok' | 'error'
  error?: string
}

export interface ExtensionHooks {
  beforeAgentStart?: (ctx: { session: Session; message: string }) => Promise<void> | void
  afterAgentComplete?: (ctx: { session: Session; response: string }) => Promise<void> | void
  beforeModelResolve?: (ctx: {
    session: Session
    prompt: string
    message: string
    provider: ProviderId
    model: string
    apiEndpoint?: string | null
  }) => Promise<ExtensionModelResolveResult | void> | ExtensionModelResolveResult | void
  beforeToolExec?: (ctx: { toolName: string; input: Record<string, unknown> | null }) => Promise<Record<string, unknown> | void> | Record<string, unknown> | void
  beforePromptBuild?: (ctx: {
    session: Session
    prompt: string
    message: string
    history: Message[]
    messages: Message[]
  }) => Promise<ExtensionPromptBuildResult | void> | ExtensionPromptBuildResult | void
  beforeToolCall?: (ctx: {
    session: Session
    toolName: string
    input: Record<string, unknown> | null
    runId?: string
    toolCallId?: string
  }) => Promise<ExtensionToolCallResult | Record<string, unknown> | void> | ExtensionToolCallResult | Record<string, unknown> | void
  llmInput?: (ctx: {
    session: Session
    runId: string
    provider: ProviderId
    model: string
    systemPrompt?: string
    prompt: string
    historyMessages: Message[]
    imagesCount: number
  }) => Promise<void> | void
  llmOutput?: (ctx: {
    session: Session
    runId: string
    provider: ProviderId
    model: string
    assistantTexts: string[]
    response: string
    usage?: {
      input?: number
      output?: number
      total?: number
      estimatedCost?: number
    }
  }) => Promise<void> | void
  toolResultPersist?: (ctx: {
    session: Session
    message: Message
    toolName?: string
    toolCallId?: string
    isSynthetic?: boolean
  }) => Promise<ExtensionMessagePersistResult | Message | void> | ExtensionMessagePersistResult | Message | void
  beforeMessageWrite?: (ctx: {
    session: Session
    message: Message
    phase?: 'user' | 'system' | 'assistant_partial' | 'assistant_final' | 'heartbeat'
    runId?: string
  }) => Promise<ExtensionBeforeMessageWriteResult | Message | void> | ExtensionBeforeMessageWriteResult | Message | void
  afterToolExec?: (ctx: { session: Session; toolName: string; input: Record<string, unknown> | null; output: string }) => Promise<void> | void
  onMessage?: (ctx: { session: Session; message: Message }) => Promise<void> | void
  sessionStart?: (ctx: {
    session: Session
    resumedFrom?: string | null
  }) => Promise<void> | void
  sessionEnd?: (ctx: {
    sessionId: string
    session?: Session | null
    messageCount: number
    durationMs?: number
    reason?: string | null
  }) => Promise<void> | void
  subagentSpawning?: (ctx: {
    parentSessionId?: string | null
    agentId: string
    agentName: string
    message: string
    cwd: string
    mode: 'run' | 'session'
    threadRequested: boolean
  }) => Promise<ExtensionSubagentSpawningResult | void> | ExtensionSubagentSpawningResult | void
  subagentSpawned?: (ctx: {
    parentSessionId?: string | null
    childSessionId: string
    agentId: string
    agentName: string
    runId: string
    mode: 'run' | 'session'
    threadRequested: boolean
  }) => Promise<void> | void
  subagentEnded?: (ctx: {
    parentSessionId?: string | null
    childSessionId: string
    agentId: string
    agentName: string
    status: 'completed' | 'failed' | 'cancelled' | 'timed_out'
    response?: string | null
    error?: string | null
    durationMs?: number
  }) => Promise<void> | void

  // Post-turn hook — fires after a full chat exchange (user message → agent response)
  afterChatTurn?: (ctx: {
    session: Session
    message: string
    response: string
    source: string
    internal: boolean
    toolEvents?: MessageToolEvent[]
  }) => Promise<void> | void

  // Orchestration & Swarm Hooks
  onTaskComplete?: (ctx: { taskId: string; result: unknown }) => Promise<void> | void
  onAgentDelegation?: (ctx: { sourceAgentId: string; targetAgentId: string; task: string }) => Promise<void> | void

  // Chat Middleware (Transform messages)
  transformInboundMessage?: (ctx: { session: Session; text: string }) => Promise<string> | string
  transformOutboundMessage?: (ctx: { session: Session; text: string }) => Promise<string> | string

  // Context injection — return a markdown string to inject into the agent's state modifier, or null/undefined to skip
  getAgentContext?: (ctx: { session: Session; enabledExtensions: string[]; message: string; history: Message[] }) => Promise<string | null | undefined> | string | null | undefined

  // Self-description — returns a capability line for the system prompt (e.g., "I can remember things across conversations")
  getCapabilityDescription?: () => string | null | undefined

  // Operating guidance — returns operational hints for the agent when this extension is active
  getOperatingGuidance?: () => string | string[] | null | undefined

  // Approval guidance — returns approval-scoped instructions when this extension is active
  getApprovalGuidance?: (ctx: {
    approval: ApprovalRequest
    phase: 'request' | 'resume' | 'connector_reminder'
    approved?: boolean
  }) => string | string[] | null | undefined
}

export interface ExtensionToolPlanning {
  /**
   * Capability tags that the harness can use for prompt guidance and tool routing.
   * Examples: research.search, research.fetch, browser.capture, artifact.pdf,
   * delivery.media, delivery.voice_note.
   */
  capabilities?: string[]
  /**
   * Concrete usage guidance that should be injected into the system prompt when
   * this tool is enabled.
   */
  disciplineGuidance?: string[]
}

export interface ExtensionToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  planning?: ExtensionToolPlanning
  execute: (args: Record<string, unknown>, ctx: { session: Session; message: string }) => Promise<string | object> | string | object
}

export interface ExtensionSettingsField {
  key: string
  label: string
  type: 'text' | 'number' | 'boolean' | 'select' | 'secret'
  placeholder?: string
  help?: string
  options?: Array<{ value: string; label: string }>
  defaultValue?: string | number | boolean
  required?: boolean
}

export interface ExtensionUIDefinition {
  sidebarItems?: Array<{
    id: string
    label: string
    icon?: string
    href: string
    position?: 'top' | 'bottom'
  }>
  headerWidgets?: Array<{
    id: string
    label: string
    icon?: string
  }>
  chatInputActions?: Array<{
    id: string
    label: string
    icon?: string
    tooltip?: string
    action: 'message' | 'link' | 'tool'
    value: string
  }>
  /** Settings fields declared by the extension, rendered in the extension settings panel */
  settingsFields?: ExtensionSettingsField[]
  /** Chat panels the extension provides (e.g., browser view, terminal) */
  chatPanels?: Array<{
    id: string
    label: string
    icon?: string
    /** WS topic to subscribe to for updates (e.g., 'browser:{sessionId}') */
    wsTopic?: string
  }>
  /** Badges to show on agent cards when this extension is enabled */
  agentBadges?: Array<{
    id: string
    label: string
    icon?: string
  }>
}

export interface ExtensionProviderDefinition {
  id: string
  name: string
  models: string[]
  requiresApiKey: boolean
  requiresEndpoint: boolean
  defaultEndpoint?: string
  streamChat: (opts: {
    session: { id: string } & Record<string, unknown>
    message: string
    imagePath?: string
    imageUrl?: string
    apiKey?: string | null
    systemPrompt?: string
    write: (data: string) => void
    active: Map<string, unknown>
    loadHistory: (sessionId: string) => unknown[]
    onUsage?: (usage: { inputTokens: number; outputTokens: number }) => void
    signal?: AbortSignal
  }) => Promise<string>
}

export interface ExtensionConnectorDefinition {
  id: string
  name: string
  description: string
  supportsBinaryMedia?: boolean
  // For sending outbound
  sendMessage?: (
    channelId: string,
    text: string,
    options?: OutboundSendOptions,
  ) => Promise<{ messageId?: string } | void>
  // For polling/listening
  startListener?: (onMessage: (msg: InboundMessage) => void) => Promise<() => void>
}

export interface Extension {
  name: string
  version?: string
  description?: string
  author?: string
  openclaw?: boolean
  enabledByDefault?: boolean
  hooks?: ExtensionHooks
  tools?: ExtensionToolDef[]
  ui?: ExtensionUIDefinition
  providers?: ExtensionProviderDefinition[]
  connectors?: ExtensionConnectorDefinition[]
}

export interface ExtensionMeta {
  name: string
  description?: string
  filename: string
  enabled: boolean
  isBuiltin?: boolean
  author?: string
  version?: string
  source?: 'local' | 'manual' | 'marketplace'
  sourceLabel?: ExtensionPublisherSource
  installSource?: ExtensionInstallSource
  sourceUrl?: string
  openclaw?: boolean
  failureCount?: number
  lastFailureAt?: number
  lastFailureStage?: string
  lastFailureError?: string
  autoDisabled?: boolean
  toolCount?: number
  hookCount?: number
  hasUI?: boolean
  providerCount?: number
  connectorCount?: number
  createdByAgentId?: string | null
  settingsFields?: ExtensionSettingsField[]
  hasDependencyManifest?: boolean
  dependencyCount?: number
  devDependencyCount?: number
  packageManager?: ExtensionPackageManager
  dependencyInstallStatus?: ExtensionDependencyInstallStatus
  dependencyInstallError?: string
  dependencyInstalledAt?: number
}

export type ExtensionPublisherSource =
  | 'builtin'
  | 'local'
  | 'manual'
  | 'swarmclaw'
  | 'swarmforge'
  | 'clawhub'

export type ExtensionCatalogSource =
  | 'swarmclaw'
  | 'swarmclaw-site'
  | 'swarmforge'
  | 'clawhub'

export type ExtensionInstallSource =
  | 'builtin'
  | 'local'
  | 'manual'
  | ExtensionCatalogSource

export type ExtensionPackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'
export type ExtensionDependencyInstallStatus = 'none' | 'ready' | 'installing' | 'installed' | 'error'

export interface MarketplaceExtension {
  id: string
  name: string
  description: string
  author: string
  version: string
  url: string
  source?: ExtensionPublisherSource
  catalogSource?: ExtensionCatalogSource
  tags?: string[]
  openclaw?: boolean
  downloads?: number
}

export interface ExtensionInvocationRecord {
  extensionId: string
  toolName: string
  inputTokens: number
  outputTokens: number
}

export interface ExtensionDefinitionCost {
  extensionId: string
  estimatedTokens: number
}
