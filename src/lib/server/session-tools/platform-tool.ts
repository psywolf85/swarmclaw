/**
 * platform-tool — Consolidated platform tool (v2).
 *
 * Single `platform` tool that dispatches dotted actions to existing service
 * functions. Replaces the need to expose separate tools for tasks, chatrooms,
 * connectors, subagents, human-loop, and platform CRUD.
 *
 * Action namespace:
 *   tasks.*          — Task CRUD and lifecycle
 *   communicate.*    — Human-loop, connector messaging, delegation, subagent spawn
 *   projects.*       — Project listing and retrieval
 *   chatrooms.*      — Chatroom messaging and listing
 *   agents.*         — Agent listing and retrieval
 */

import { z } from 'zod'
import { tool, type StructuredToolInterface } from '@langchain/core/tools'
import type { Extension, ExtensionHooks, BoardTask, BoardTaskStatus, Project, Chatroom } from '@/types'
import type { ToolBuildContext } from './context'
import { truncate, MAX_OUTPUT } from './context'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { errorMessage } from '@/lib/shared-utils'
import { genId } from '@/lib/id'
import {
  loadAgents,
  loadTasks,
  loadTask,
  upsertTask,
  loadProjects,
  loadChatrooms,
  loadChatroom,
  saveChatrooms,
} from '../storage'
import { notify } from '../ws-hub'
import { logExecution } from '../execution-log'
import { logActivity } from '../storage'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PlatformActionContext {
  agentId?: string | null
  sessionId?: string | null
  cwd: string
  delegationEnabled?: boolean
  delegationTargetMode?: 'all' | 'selected'
  delegationTargetAgentIds?: string[]
  bctx?: ToolBuildContext
}

type ActionHandler = (
  params: Record<string, unknown>,
  ctx: PlatformActionContext,
) => Promise<string> | string

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireString(params: Record<string, unknown>, key: string): string {
  const val = typeof params[key] === 'string' ? (params[key] as string).trim() : ''
  if (!val) throw new Error(`${key} is required.`)
  return val
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const val = params[key]
  return typeof val === 'string' && val.trim() ? val.trim() : undefined
}

const VALID_TASK_STATUSES: BoardTaskStatus[] = [
  'backlog', 'queued', 'running', 'completed', 'failed', 'cancelled', 'archived', 'deferred',
]

function isValidTaskStatus(value: unknown): value is BoardTaskStatus {
  return typeof value === 'string' && VALID_TASK_STATUSES.includes(value as BoardTaskStatus)
}

// ---------------------------------------------------------------------------
// tasks.* handlers
// ---------------------------------------------------------------------------

function handleTasksCreate(params: Record<string, unknown>, ctx: PlatformActionContext): string {
  const title = requireString(params, 'title')
  const description = optionalString(params, 'description') || ''
  const assignee = optionalString(params, 'assignee') || optionalString(params, 'agentId') || ctx.agentId || ''
  const status: BoardTaskStatus = isValidTaskStatus(params.status) ? params.status : 'backlog'
  const projectId = optionalString(params, 'projectId')

  const now = Date.now()
  const task: BoardTask = {
    id: genId(),
    title,
    description,
    status,
    agentId: assignee,
    projectId,
    createdByAgentId: ctx.agentId || null,
    createdInSessionId: ctx.sessionId || null,
    createdAt: now,
    updatedAt: now,
  }

  upsertTask(task.id, task)
  notify('tasks')

  logActivity({
    entityType: 'task',
    entityId: task.id,
    action: 'created',
    actor: 'agent',
    actorId: ctx.agentId || undefined,
    summary: `Task created: ${title}`,
  })

  return JSON.stringify({ ok: true, task: { id: task.id, title, status, agentId: assignee, projectId } })
}

function handleTasksUpdate(params: Record<string, unknown>, ctx: PlatformActionContext): string {
  const taskId = requireString(params, 'taskId')
  const existing = loadTask(taskId)
  if (!existing) return `Error: task "${taskId}" not found.`

  const updates: Partial<BoardTask> = { updatedAt: Date.now() }
  if (typeof params.title === 'string' && params.title.trim()) updates.title = params.title.trim()
  if (typeof params.description === 'string') updates.description = params.description.trim()
  if (isValidTaskStatus(params.status)) updates.status = params.status
  if (typeof params.result === 'string') updates.result = params.result.trim()
  if (typeof params.agentId === 'string') updates.agentId = params.agentId.trim()
  if (typeof params.projectId === 'string') updates.projectId = params.projectId.trim()

  if (updates.status === 'completed' && !existing.completedAt) {
    updates.completedAt = Date.now()
  }

  const merged = { ...existing, ...updates }
  upsertTask(taskId, merged)
  notify('tasks')

  logActivity({
    entityType: 'task',
    entityId: taskId,
    action: 'updated',
    actor: 'agent',
    actorId: ctx.agentId || undefined,
    summary: `Task updated: ${merged.title}`,
  })

  return JSON.stringify({ ok: true, task: { id: taskId, title: merged.title, status: merged.status } })
}

function handleTasksList(params: Record<string, unknown>, _ctx: PlatformActionContext): string {
  const all = loadTasks()
  let tasks = Object.values(all) as BoardTask[]

  // Optional filters
  const filterStatus = optionalString(params, 'status')
  const filterAgentId = optionalString(params, 'agentId') || optionalString(params, 'assignee')
  const filterProjectId = optionalString(params, 'projectId')

  if (filterStatus && isValidTaskStatus(filterStatus)) {
    tasks = tasks.filter((t) => t.status === filterStatus)
  }
  if (filterAgentId) {
    tasks = tasks.filter((t) => t.agentId === filterAgentId)
  }
  if (filterProjectId) {
    tasks = tasks.filter((t) => t.projectId === filterProjectId)
  }

  // Default: exclude archived
  if (!filterStatus) {
    tasks = tasks.filter((t) => t.status !== 'archived')
  }

  tasks.sort((a, b) => b.updatedAt - a.updatedAt)

  const limit = typeof params.limit === 'number' ? Math.min(params.limit, 100) : 50
  const summary = tasks.slice(0, limit).map((t) => ({
    id: t.id,
    title: t.title,
    status: t.status,
    agentId: t.agentId,
    projectId: t.projectId || null,
    updatedAt: t.updatedAt,
  }))
  return JSON.stringify(summary)
}

function handleTasksGet(params: Record<string, unknown>, _ctx: PlatformActionContext): string {
  const taskId = requireString(params, 'taskId')
  const task = loadTask(taskId)
  if (!task) return `Error: task "${taskId}" not found.`
  return JSON.stringify(task)
}

function handleTasksComplete(params: Record<string, unknown>, ctx: PlatformActionContext): string {
  const taskId = requireString(params, 'taskId')
  const existing = loadTask(taskId)
  if (!existing) return `Error: task "${taskId}" not found.`

  const result = optionalString(params, 'result') || 'Completed'
  const now = Date.now()
  const merged: BoardTask = {
    ...existing,
    status: 'completed',
    result,
    completedAt: now,
    updatedAt: now,
  }
  upsertTask(taskId, merged)
  notify('tasks')

  logActivity({
    entityType: 'task',
    entityId: taskId,
    action: 'completed',
    actor: 'agent',
    actorId: ctx.agentId || undefined,
    summary: `Task completed: ${merged.title}`,
  })

  return JSON.stringify({ ok: true, task: { id: taskId, title: merged.title, status: 'completed', result } })
}

// ---------------------------------------------------------------------------
// communicate.* handlers
// ---------------------------------------------------------------------------

async function handleCommunicateAskHuman(
  params: Record<string, unknown>,
  ctx: PlatformActionContext,
): Promise<string> {
  // Delegate to the existing human-loop executeHumanLoopAction logic
  // by dynamically importing to avoid circular deps
  const { buildHumanLoopTools } = await import('./human-loop')
  const bctx = ctx.bctx
  if (!bctx) return 'Error: build context not available for ask_human.'

  // Determine the sub-action: map communicate.ask_human params to human-loop actions
  const subAction = optionalString(params, 'subAction') || 'request_input'
  const humanArgs: Record<string, unknown> = {
    ...params,
    action: subAction,
  }
  // Remove our routing keys
  delete humanArgs.subAction

  // Build the human-loop tool and invoke it
  const tools = buildHumanLoopTools(bctx)
  if (tools.length === 0) return 'Error: ask_human extension is not enabled.'
  const result = await tools[0].invoke(humanArgs)
  const resultStr = typeof result === 'string' ? result : JSON.stringify(result)

  // Tag durable_wait outputs so the terminal boundary resolver can detect them
  if (
    (subAction === 'wait_for_reply' || subAction === 'wait_for_approval')
    && resultStr.includes('"status":"active"')
  ) {
    // The output already has the right shape for resolveSuccessfulTerminalToolBoundary
    // to detect it via the ask_human canonical name check. But since our tool is named
    // "platform", we embed a marker field so the boundary resolver can be extended.
    try {
      const parsed = JSON.parse(resultStr) as Record<string, unknown>
      return JSON.stringify({
        ...parsed,
        __terminal_boundary: 'durable_wait',
      })
    } catch {
      return resultStr
    }
  }

  return resultStr
}

async function handleCommunicateSendMessage(
  params: Record<string, unknown>,
  ctx: PlatformActionContext,
): Promise<string> {
  // Delegate to the existing connector action
  const bctx = ctx.bctx
  if (!bctx) return 'Error: build context not available for send_message.'

  const { buildConnectorTools } = await import('./connector')
  const tools = buildConnectorTools(bctx)
  if (tools.length === 0) return 'Error: connector_message_tool extension is not enabled.'

  const connectorArgs: Record<string, unknown> = {
    action: 'send',
    ...params,
  }
  const result = await tools[0].invoke(connectorArgs)
  return typeof result === 'string' ? result : JSON.stringify(result)
}

async function handleCommunicateDelegate(
  params: Record<string, unknown>,
  ctx: PlatformActionContext,
): Promise<string> {
  const bctx = ctx.bctx
  if (!bctx) return 'Error: build context not available for delegate.'

  const { buildDelegateTools } = await import('./delegate')
  const tools = buildDelegateTools(bctx)
  if (tools.length === 0) return 'Error: delegate extension is not enabled or delegation is disabled.'

  const delegateArgs: Record<string, unknown> = {
    action: 'start',
    ...params,
  }
  const result = await tools[0].invoke(delegateArgs)
  return typeof result === 'string' ? result : JSON.stringify(result)
}

async function handleCommunicateSpawn(
  params: Record<string, unknown>,
  ctx: PlatformActionContext,
): Promise<string> {
  const bctx = ctx.bctx
  if (!bctx) return 'Error: build context not available for spawn.'

  const { buildSubagentTools } = await import('./subagent')
  const tools = buildSubagentTools(bctx)
  if (tools.length === 0) return 'Error: spawn_subagent extension is not enabled or delegation is disabled.'

  const subagentArgs: Record<string, unknown> = {
    action: 'start',
    ...params,
  }
  const result = await tools[0].invoke(subagentArgs)
  return typeof result === 'string' ? result : JSON.stringify(result)
}

// ---------------------------------------------------------------------------
// projects.* handlers
// ---------------------------------------------------------------------------

function handleProjectsList(_params: Record<string, unknown>, _ctx: PlatformActionContext): string {
  const all = loadProjects()
  const projects = Object.values(all) as Project[]
  const summary = projects.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    updatedAt: p.updatedAt,
  }))
  return JSON.stringify(summary)
}

function handleProjectsGet(params: Record<string, unknown>, _ctx: PlatformActionContext): string {
  const projectId = requireString(params, 'projectId')
  const all = loadProjects()
  const project = (all as Record<string, Project>)[projectId]
  if (!project) return `Error: project "${projectId}" not found.`
  return JSON.stringify(project)
}

// ---------------------------------------------------------------------------
// chatrooms.* handlers
// ---------------------------------------------------------------------------

function handleChatroomsSend(params: Record<string, unknown>, ctx: PlatformActionContext): string {
  const chatroomId = requireString(params, 'chatroomId')
  const message = requireString(params, 'message')
  const chatrooms = loadChatrooms() as Record<string, Chatroom>
  const chatroom = chatrooms[chatroomId]
  if (!chatroom) return `Error: chatroom "${chatroomId}" not found.`

  const agents = loadAgents()
  const senderName = ctx.agentId ? (agents[ctx.agentId]?.name || 'Agent') : 'Agent'
  const msgId = genId()
  const targetAgentId = optionalString(params, 'targetAgentId')

  chatroom.messages.push({
    id: msgId,
    senderId: ctx.agentId || 'agent',
    senderName,
    role: 'assistant' as const,
    text: message,
    mentions: [],
    reactions: [],
    time: Date.now(),
    ...(targetAgentId ? { targetAgentId } : {}),
  })
  chatroom.updatedAt = Date.now()
  saveChatrooms(chatrooms)
  notify(`chatroom:${chatroomId}`)

  logExecution(ctx.sessionId || '', 'chatroom_message', `Message sent in ${chatroom.name}`, {
    agentId: ctx.agentId,
    detail: { chatroomId, senderId: ctx.agentId, messageLen: message.length },
  })

  return JSON.stringify({ ok: true, messageId: msgId })
}

function handleChatroomsList(_params: Record<string, unknown>, _ctx: PlatformActionContext): string {
  const chatrooms = loadChatrooms() as Record<string, Chatroom>
  const list = Object.values(chatrooms).map((cr) => ({
    id: cr.id,
    name: cr.name,
    description: cr.description,
    memberCount: cr.agentIds.length,
    messageCount: cr.messages.length,
  }))
  return JSON.stringify(list)
}

function handleChatroomsHistory(params: Record<string, unknown>, _ctx: PlatformActionContext): string {
  const chatroomId = requireString(params, 'chatroomId')
  const chatroom = loadChatroom(chatroomId)
  if (!chatroom) return `Error: chatroom "${chatroomId}" not found.`

  const limit = typeof params.limit === 'number' ? Math.min(params.limit, 50) : 20
  const messages = chatroom.messages.slice(-limit).map((msg) => ({
    id: msg.id,
    sender: msg.senderName,
    senderId: msg.senderId,
    text: msg.text.slice(0, 300),
    time: msg.time,
    ...(msg.targetAgentId ? { targetAgentId: msg.targetAgentId } : {}),
    ...(msg.replyToId ? { replyToId: msg.replyToId } : {}),
  }))
  return JSON.stringify(messages)
}

// ---------------------------------------------------------------------------
// agents.* handlers
// ---------------------------------------------------------------------------

function handleAgentsList(_params: Record<string, unknown>, _ctx: PlatformActionContext): string {
  const all = loadAgents()
  const agents = Object.values(all).map((a) => ({
    id: a.id,
    name: a.name,
    description: a.description || '',
    provider: a.provider,
    model: a.model,
  }))
  return JSON.stringify(agents)
}

function handleAgentsGet(params: Record<string, unknown>, _ctx: PlatformActionContext): string {
  const agentId = requireString(params, 'agentId')
  const all = loadAgents()
  const agent = all[agentId]
  if (!agent) return `Error: agent "${agentId}" not found.`
  // Return a safe subset — omit API keys and sensitive config
  return JSON.stringify({
    id: agent.id,
    name: agent.name,
    description: agent.description || '',
    provider: agent.provider,
    model: agent.model,
    soul: agent.soul || '',
    capabilities: agent.capabilities || [],
  })
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

const ACTION_MAP: Record<string, ActionHandler> = {
  // Tasks
  'tasks.create': handleTasksCreate,
  'tasks.update': handleTasksUpdate,
  'tasks.list': handleTasksList,
  'tasks.get': handleTasksGet,
  'tasks.complete': handleTasksComplete,

  // Communication
  'communicate.ask_human': handleCommunicateAskHuman,
  'communicate.send_message': handleCommunicateSendMessage,
  'communicate.delegate': handleCommunicateDelegate,
  'communicate.spawn': handleCommunicateSpawn,

  // Projects
  'projects.list': handleProjectsList,
  'projects.get': handleProjectsGet,

  // Chatrooms
  'chatrooms.send': handleChatroomsSend,
  'chatrooms.list': handleChatroomsList,
  'chatrooms.history': handleChatroomsHistory,

  // Agents
  'agents.list': handleAgentsList,
  'agents.get': handleAgentsGet,
}

const VALID_ACTIONS = Object.keys(ACTION_MAP)

async function executePlatformV2Action(
  args: Record<string, unknown>,
  ctx: PlatformActionContext,
): Promise<string> {
  const normalized = normalizeToolInputArgs(args)
  const action = typeof normalized.action === 'string'
    ? normalized.action.trim().toLowerCase()
    : ''

  if (!action) {
    return `Error: action is required. Valid actions: ${VALID_ACTIONS.join(', ')}.`
  }

  const handler = ACTION_MAP[action]
  if (!handler) {
    // Try fuzzy matching — help LLMs that drop the dot or use underscores
    const fuzzyAction = action.replace(/_/g, '.')
    const fuzzyHandler = ACTION_MAP[fuzzyAction]
    if (fuzzyHandler) {
      try {
        const result = await fuzzyHandler(normalized, ctx)
        return truncate(result, MAX_OUTPUT)
      } catch (err: unknown) {
        return `Error: ${errorMessage(err)}`
      }
    }

    return `Error: Unknown action "${action}". Valid actions: ${VALID_ACTIONS.join(', ')}.`
  }

  try {
    const result = await handler(normalized, ctx)
    return truncate(result, MAX_OUTPUT)
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

const PlatformV2Extension: Extension = {
  name: 'Platform V2',
  enabledByDefault: false,
  description: 'Consolidated platform tool for tasks, communication, projects, chatrooms, and agent management.',
  hooks: {
    getCapabilityDescription: () =>
      'I can manage tasks, communicate with humans and other agents, browse projects and chatrooms, and list agents — all via the unified `platform` tool with dotted actions like `tasks.create`, `communicate.ask_human`, `chatrooms.send`.',
    getOperatingGuidance: () => [
      'Use `platform` with action "tasks.create" to create tasks, "tasks.update" to update, "tasks.complete" to mark done.',
      'Use "communicate.ask_human" with subAction "request_input" to ask a human, then "wait_for_reply" to pause. Do not repeat pending questions.',
      'Use "communicate.send_message" to send connector messages, "communicate.delegate" to delegate to CLI agents, "communicate.spawn" to spawn subagents.',
      'Use "projects.list" and "projects.get" for project info, "chatrooms.list" and "chatrooms.send" for chatrooms.',
      'Use "agents.list" and "agents.get" to discover available agents.',
    ],
  } as ExtensionHooks,
  tools: [
    {
      name: 'platform',
      description:
        'Consolidated platform tool. Use dotted action names: '
        + 'tasks.create, tasks.update, tasks.list, tasks.get, tasks.complete, '
        + 'communicate.ask_human (subAction: request_input|wait_for_reply|wait_for_approval|list_mailbox|ack_mailbox|status), '
        + 'communicate.send_message, communicate.delegate, communicate.spawn, '
        + 'projects.list, projects.get, '
        + 'chatrooms.send, chatrooms.list, chatrooms.history, '
        + 'agents.list, agents.get.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            description: 'Dotted action name, e.g. "tasks.create", "communicate.ask_human"',
          },
        },
        required: ['action'],
      },
      execute: async (args, context) => {
        const sessionAgentId = context.session.agentId || undefined
        return executePlatformV2Action(args as Record<string, unknown>, {
          agentId: sessionAgentId,
          sessionId: context.session.id,
          cwd: context.session.cwd || process.cwd(),
        })
      },
    },
  ],
}

registerNativeCapability('platform_v2', PlatformV2Extension)

// ---------------------------------------------------------------------------
// Tool builder (called from session-tools/index.ts)
// ---------------------------------------------------------------------------

export function buildPlatformV2Tools(bctx: ToolBuildContext): StructuredToolInterface[] {
  if (!bctx.hasExtension('platform_v2')) return []

  const sessionAgentId = bctx.ctx?.agentId || undefined

  return [
    tool(
      async (args) =>
        executePlatformV2Action(args, {
          agentId: sessionAgentId,
          sessionId: bctx.ctx?.sessionId,
          cwd: bctx.cwd,
          delegationEnabled: bctx.ctx?.delegationEnabled,
          delegationTargetMode: bctx.ctx?.delegationTargetMode,
          delegationTargetAgentIds: bctx.ctx?.delegationTargetAgentIds,
          bctx,
        }),
      {
        name: 'platform',
        description: PlatformV2Extension.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
