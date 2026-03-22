/**
 * memory — Consolidated memory tool with action-based dispatch.
 *
 * Single tool surface that replaces the five separate memory_* tools.
 * Actions:
 *   read   — Read a specific memory entry by id or key (maps to "get")
 *   write  — Store or update a durable memory (TERMINAL — memory_write boundary)
 *   search — Semantic search across memory
 *   list   — List memory entries
 *
 * Legacy action names (store, update, get, delete, link, unlink, doctor) are
 * also accepted and routed directly to executeMemoryAction for full backward
 * compatibility.
 *
 * Memory is agent-level: it stores what the agent has learned about users,
 * projects, decisions, and its environment — not platform configuration.
 */

import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { Extension, ExtensionHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { errorMessage } from '@/lib/shared-utils'
import { log } from '../logger'
import { normalizeToolInputArgs } from './normalize-tool-args'
import type { ToolBuildContext } from './context'
import { executeMemoryAction, MemoryExtension as OriginalMemoryExtension } from './memory'

const TAG = 'memory-tool'

// ---------------------------------------------------------------------------
// Action mapping: new consolidated names → legacy action names
// ---------------------------------------------------------------------------

/** Maps consolidated action names to the legacy names used by executeMemoryAction */
const ACTION_MAP: Record<string, string> = {
  read: 'get',
  write: 'store',
  search: 'search',
  list: 'list',
}

/** Actions that are passed through directly (legacy action names) */
const PASSTHROUGH_ACTIONS = new Set([
  'store', 'update', 'get', 'search', 'list', 'delete', 'link', 'unlink', 'doctor',
])

/** Actions that are write mutations and should trigger the memory_write terminal boundary */
const WRITE_ACTIONS = new Set(['write', 'store', 'update'])

function resolveAction(raw: string): string {
  const trimmed = raw.trim().toLowerCase()
  if (ACTION_MAP[trimmed]) return ACTION_MAP[trimmed]
  if (PASSTHROUGH_ACTIONS.has(trimmed)) return trimmed
  return trimmed
}

// ---------------------------------------------------------------------------
// File-content guard (prevents models from confusing memory with file writes)
// ---------------------------------------------------------------------------

function looksLikeFileContent(args: Record<string, unknown>): boolean {
  const value = typeof args.value === 'string' ? args.value : ''
  const title = typeof args.title === 'string' ? args.title : ''
  const key = typeof args.key === 'string' ? args.key : ''
  const category = typeof args.category === 'string' ? args.category : ''
  const allText = `${title} ${key} ${category} ${value}`

  const hasFileExtension = /\.\w{1,5}$/.test(title || key)
  const hasFilePath = /(?:^|[\s"'/])(?:\/[\w.-]+){2,}\.[\w]{1,5}\b/.test(allText)
  const mentionsFileOp = /\b(?:csv|file|refactor|code|script|document|spreadsheet|inventory)\b/i.test(allText)
  const lineCount = (value.match(/\n/g) || []).length + 1
  const looksLikeCode = /^(import |export |function |const |let |var |class |interface |type |def |from |#include|package |using )/m.test(value)
  const looksLikeCsv = lineCount >= 3 && (value.match(/,/g) || []).length >= lineCount * 2
  const looksLikeStructuredData = lineCount >= 5 && (/^\s*[\[{]/m.test(value) || looksLikeCsv)

  if (hasFileExtension || hasFilePath || (mentionsFileOp && (!value || value.length > 200))) {
    return true
  }
  if (value.length > 500 && (looksLikeCode || looksLikeStructuredData || looksLikeCsv)) {
    return true
  }
  return false
}

const FILE_REDIRECT_MSG =
  'Error: memory write is only for remembering facts, preferences, and decisions — NOT for creating files, CSV data, code, or documents. ' +
  'To write a file, use the `files` tool: files({action:"write", files:[{path:"path/to/file", content:"..."}]})'

// ---------------------------------------------------------------------------
// Unified action dispatch
// ---------------------------------------------------------------------------

async function memoryAction(
  args: Record<string, unknown>,
  ctx: Parameters<typeof executeMemoryAction>[1],
): Promise<string> {
  const normalized = normalizeToolInputArgs(args)
  const rawAction = typeof normalized.action === 'string' ? normalized.action : ''

  if (!rawAction) {
    return 'Error: `action` parameter is required. Valid actions: read, write, search, list (also: store, update, get, delete, link, unlink, doctor).'
  }

  const resolvedAction = resolveAction(rawAction)

  log.info(TAG, `memory action=${rawAction} (resolved=${resolvedAction})`, {
    agentId: typeof ctx?.agentId === 'string' ? ctx.agentId : undefined,
    sessionId: typeof ctx?.sessionId === 'string' ? ctx.sessionId : undefined,
  })

  // File-content guard for write mutations (same guard as the old memory_store tool)
  if (WRITE_ACTIONS.has(rawAction.trim().toLowerCase()) && looksLikeFileContent(normalized)) {
    return FILE_REDIRECT_MSG
  }

  try {
    // Map to executeMemoryAction with the resolved legacy action name
    return await executeMemoryAction(
      { ...normalized, action: resolvedAction },
      ctx,
    )
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

const MemoryToolExtension: Extension = {
  name: 'Core Memory',
  description:
    'Agent-level long-term memory system. Memory stores what this agent has learned — ' +
    'user preferences, decisions, project context, relationships, and environment details. ' +
    'Not for platform configuration or system settings.',
  hooks: {
    // Reuse all hooks from the original memory extension
    ...OriginalMemoryExtension.hooks,
    getCapabilityDescription: () =>
      'I have long-term memory (`memory` tool) that persists across conversations. ' +
      'Working memory is session-scoped and ephemeral — good for scratch notes and in-progress work. ' +
      'Durable memory persists across sessions — for stable facts, preferences, decisions, and learned knowledge. ' +
      'I can search, read, write, and list memories.',
    getOperatingGuidance: () => [
      'Memory: use the `memory` tool with an action parameter. For past-conversation recall, use action "search" then "read". For storing facts or corrections, use action "write". For listing all memories, use action "list".',
      'For info already in the current conversation, respond directly without calling the memory tool.',
      'For questions about prior work, decisions, dates, people, preferences, or todos from earlier conversations: start with one durable memory search, then use read only if you need a more targeted entry. Only use archive/session history when the user explicitly needs transcript-level detail or the durable search is insufficient.',
      'When the user directly says to remember, store, or correct a fact, do one write call immediately. Treat the newest direct user statement as authoritative.',
      'When one user message contains multiple related facts to remember, prefer one canonical write that captures the full set instead of many near-duplicate calls.',
      'If someone says "remember this", write it down; do not rely on RAM alone.',
      'Memory writes merge canonical memories and retire superseded variants. After a successful write, do not keep re-searching unless the user explicitly asked you to verify.',
      'By default, memory searches focus on durable memories. Only include archives or working execution notes when you explicitly need transcript or run-history context.',
      'For open goals, form a hypothesis and execute — do not keep re-asking broad questions.',
      'NEVER use the memory tool to create files, CSV data, code, or documents — always use the `files` tool for those.',
    ],
  } as ExtensionHooks,
  tools: [
    {
      name: 'memory',
      description:
        'Agent-level long-term memory. Store and recall facts, preferences, decisions, and knowledge across conversations. ' +
        'Write actions merge matching canonical memories and retire superseded variants. ' +
        'Search defaults to durable memories unless sources explicitly include archive or working.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'write', 'search', 'list', 'store', 'update', 'get', 'delete', 'link', 'unlink', 'doctor'],
            description: 'The memory operation to perform',
          },
          id: { type: 'string', description: 'Memory entry ID (for read, write/update, delete, link, unlink)' },
          key: { type: 'string', description: 'Memory key or lookup name' },
          title: { type: 'string', description: 'Human-readable title for the memory entry' },
          value: { type: 'string', description: 'Memory content to store or update' },
          category: {
            type: 'string',
            description: 'Category (e.g., identity/preferences, knowledge/facts, projects/decisions, working/scratch)',
          },
          query: { type: 'string', description: 'Search query for semantic memory lookup' },
          sources: {
            type: 'array',
            items: { type: 'string', enum: ['durable', 'working', 'archive', 'all'] },
            description: 'Which memory tiers to search (default: durable)',
          },
          scope: {
            type: 'string',
            enum: ['auto', 'all', 'global', 'shared', 'agent', 'session', 'project'],
            description: 'Memory scope filter',
          },
          rerank: {
            type: 'string',
            enum: ['balanced', 'semantic', 'lexical'],
            description: 'Search reranking strategy',
          },
          targetIds: { type: 'array', items: { type: 'string' }, description: 'Target memory IDs for link/unlink' },
          pinned: { type: 'boolean', description: 'Pin this memory so it always loads in context' },
          sharedWith: { type: 'array', items: { type: 'string' }, description: 'Agent IDs to share this memory with' },
          references: { type: 'array', description: 'Reference objects to attach to the memory' },
          filePaths: { type: 'array', description: 'File references to attach to the memory' },
          linkedMemoryIds: { type: 'array', items: { type: 'string' }, description: 'IDs of related memories to link' },
          metadata: { type: 'object', description: 'Arbitrary metadata to attach to the memory entry' },
        },
        required: ['action'],
      },
      execute: async (args, context) =>
        memoryAction(args as Record<string, unknown>, context.session),
      planning: {
        capabilities: ['memory.search', 'memory.write'],
        disciplineGuidance: [
          'Use the `memory` tool for all memory operations: read, write, search, list.',
          'For past-conversation recall, start with action "search". Use "read" only for targeted entry lookup.',
          'For storing facts or corrections, use action "write" immediately.',
          'NEVER use the memory tool to create files, documents, or data exports.',
        ],
      },
    },
  ],
}

registerNativeCapability('memory', MemoryToolExtension)

// ---------------------------------------------------------------------------
// Tool builder (called from session-tools/index.ts)
// ---------------------------------------------------------------------------

export function buildMemoryTool(bctx: ToolBuildContext) {
  if (!bctx.hasExtension('memory')) return []

  return [
    tool(
      async (args) => memoryAction(args, bctx.ctx),
      {
        name: 'memory',
        description: MemoryToolExtension.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
