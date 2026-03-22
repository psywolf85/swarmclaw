/**
 * files-tool — Consolidated file operations tool.
 *
 * Merges the capabilities of file.ts (read/write/list/copy/move/delete)
 * and edit_file.ts (surgical string replacement) into a single tool
 * with an `action` discriminator, plus a new `search` action.
 *
 * Actions:
 *   read   — Read file contents (optional offset/limit for line ranges)
 *   write  — Write/overwrite a file (supports bulk via files[])
 *   edit   — Surgical old_string -> new_string replacement
 *   list   — List directory contents (with depth control)
 *   search — Search file contents (grep-like, with include glob filter)
 */

import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import fs from 'fs'
import path from 'path'
import type { Extension, ExtensionHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { normalizeToolInputArgs } from './normalize-tool-args'
import { checkFileAccess } from './file-access-policy'
import { errorMessage } from '@/lib/shared-utils'
import { log } from '../logger'
import type { ToolBuildContext } from './context'
import { safePath, truncate, listDirRecursive, MAX_FILE, MAX_OUTPUT } from './context'

const TAG = 'files-tool'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FilesAction = 'read' | 'write' | 'edit' | 'list' | 'search'

interface FilesToolContext {
  cwd: string
  filesystemScope?: 'workspace' | 'machine'
  fileAccessPolicy?: { allowedPaths?: string[]; blockedPaths?: string[] } | null
}

interface NormalizedFilesArgs {
  action: FilesAction | undefined
  path: string | undefined
  content: string | undefined
  encoding: string | undefined
  // read
  offset: number | undefined
  limit: number | undefined
  // edit
  oldString: string | undefined
  newString: string | undefined
  // list
  depth: number | undefined
  // search
  query: string | undefined
  include: string | undefined
  // write bulk
  files: Array<Record<string, unknown>> | undefined
}

// ---------------------------------------------------------------------------
// Arg normalization helpers
// ---------------------------------------------------------------------------

function pickString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string') {
      const trimmed = v.trim()
      if (trimmed) return trimmed
    }
  }
  return undefined
}

function pickNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
    if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) return n
    }
  }
  return undefined
}

function pickStringRaw(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string') return v
  }
  return undefined
}

function parseFileEntries(value: unknown): Array<Record<string, unknown>> | undefined {
  const candidates = [value]
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.startsWith('[')) {
      try {
        candidates.unshift(JSON.parse(trimmed))
      } catch {
        // ignore malformed JSON
      }
    }
  }
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    return candidate.filter(
      (entry): entry is Record<string, unknown> =>
        !!entry && typeof entry === 'object' && !Array.isArray(entry),
    )
  }
  return undefined
}

function getEntryPath(entry: Record<string, unknown> | undefined): string | undefined {
  if (!entry) return undefined
  return pickString(
    entry.path,
    entry.filePath,
    entry.filename,
    entry.fileName,
    entry.name,
    entry.targetPath,
    entry.target,
  )
}

function getEntryContent(entry: Record<string, unknown> | undefined): string | undefined {
  if (!entry) return undefined
  const raw = entry.content ?? entry.text ?? entry.contents ?? entry.value ?? entry.body
  if (raw === undefined || raw === null) return undefined
  return typeof raw === 'string' ? raw : JSON.stringify(raw)
}

/**
 * Infer the action when the LLM doesn't provide one explicitly.
 */
function inferAction(
  normalized: Record<string, unknown>,
  files: Array<Record<string, unknown>> | undefined,
  filePath: string | undefined,
): FilesAction {
  // If old_string/oldString is present, it's an edit
  if (normalized.oldString !== undefined || normalized.old_string !== undefined) return 'edit'
  // If query/search/pattern is present, it's a search
  if (normalized.query !== undefined || normalized.search !== undefined || normalized.pattern !== undefined) return 'search'
  // If files array has content, it's a write
  if (Array.isArray(files) && files.some((e) => getEntryContent(e) !== undefined)) return 'write'
  // If content is present, it's a write
  if (normalized.content !== undefined || normalized.text !== undefined || normalized.body !== undefined) return 'write'
  // If depth is present or path looks like a directory, it's a list
  if (normalized.depth !== undefined) return 'list'
  if (normalized.dirPath !== undefined || normalized.directory !== undefined || normalized.dir !== undefined) return 'list'
  if (filePath && filePath.endsWith('/')) return 'list'
  // Default: if we have a path, read it; otherwise list cwd
  return filePath ? 'read' : 'list'
}

/**
 * Normalize the chaotic LLM arg shapes into a clean internal structure.
 */
function normalizeArgs(rawArgs: Record<string, unknown>): NormalizedFilesArgs {
  const n = normalizeToolInputArgs(rawArgs)

  // Some LLMs nest the payload under the action key: { read: { path: "..." } }
  const actionPayload = (['read', 'write', 'edit', 'list', 'search'] as const)
    .map((candidate) => {
      const value = n[candidate]
      return value && typeof value === 'object' && !Array.isArray(value)
        ? { action: candidate, value: value as Record<string, unknown> }
        : null
    })
    .find(Boolean)

  const merged: Record<string, unknown> = { ...n, ...(actionPayload?.value ?? {}) }
  const files = parseFileEntries(merged.files)

  const filePath = pickString(
    merged.filePath, merged.filepath, merged.path, merged.file,
    merged.filename, merged.fileName, merged.name, merged.targetPath,
    merged.target, merged.dirPath, merged.directory, merged.directoryPath,
    merged.dir, merged.folder,
  )

  let action = pickString(n.action, actionPayload?.action) as FilesAction | undefined
  if (!action && Array.isArray(files) && files.length > 0) {
    action = pickString(files[0].action) as FilesAction | undefined
  }
  if (!action) {
    action = inferAction(merged, files, filePath)
  }

  return {
    action,
    path: filePath,
    content: pickStringRaw(merged.content, merged.text, merged.contents, merged.value, merged.body),
    encoding: pickString(merged.encoding),
    offset: pickNumber(merged.offset, merged.startLine, merged.start_line, merged.from_line),
    limit: pickNumber(merged.limit, merged.lineCount, merged.line_count, merged.maxLines, merged.max_lines, merged.lines),
    oldString: pickStringRaw(merged.oldString, merged.old_string, merged.oldText, merged.old_text, merged.find, merged.search_string),
    newString: pickStringRaw(merged.newString, merged.new_string, merged.newText, merged.new_text, merged.replace, merged.replacement),
    depth: pickNumber(merged.depth, merged.maxDepth, merged.max_depth),
    query: pickString(merged.query, merged.search, merged.pattern, merged.grep, merged.regex),
    include: pickString(merged.include, merged.glob, merged.filePattern, merged.file_pattern),
    files,
  }
}

// ---------------------------------------------------------------------------
// Path resolution + access policy enforcement
// ---------------------------------------------------------------------------

function resolveFilePath(cwd: string, target: string, scope?: 'workspace' | 'machine'): string {
  try {
    return safePath(cwd, target, scope)
  } catch (err: unknown) {
    // For absolute paths, try resolving against process.cwd() as a fallback
    if (!path.isAbsolute(target)) throw err
    return safePath(process.cwd(), target, scope)
  }
}

function enforceAccess(
  filePath: string,
  cwd: string,
  policy: FilesToolContext['fileAccessPolicy'],
): string | null {
  if (!policy) return null
  const result = checkFileAccess(filePath, cwd, policy)
  if (!result.allowed) return result.reason ?? 'File access denied by policy'
  return null
}

// ---------------------------------------------------------------------------
// Binary file detection
// ---------------------------------------------------------------------------

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.svg', '.pdf',
  '.zip', '.gz', '.tar', '.tgz', '.7z', '.rar',
  '.mp3', '.wav', '.ogg', '.m4a', '.mp4', '.mov', '.avi', '.webm',
  '.woff', '.woff2', '.ttf', '.otf',
  '.exe', '.dll', '.so', '.dylib', '.bin',
])

function isLikelyBinary(resolvedPath: string, data: Buffer): boolean {
  const ext = path.extname(resolvedPath).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) return true
  const sample = data.subarray(0, Math.min(data.length, 512))
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

// ---------------------------------------------------------------------------
// Action implementations
// ---------------------------------------------------------------------------

function actionRead(args: NormalizedFilesArgs, ctx: FilesToolContext): string {
  const target = args.path
  if (!target) return 'Error: path is required for read action.'

  const blocked = enforceAccess(target, ctx.cwd, ctx.fileAccessPolicy)
  if (blocked) return `Error: ${blocked}`

  const resolved = resolveFilePath(ctx.cwd, target, ctx.filesystemScope)
  const data = fs.readFileSync(resolved)

  if (isLikelyBinary(resolved, data)) {
    return `Binary file: ${target} (${data.byteLength} bytes). Contents not displayed.`
  }

  let text = data.toString('utf-8')

  // Apply line-range slicing if offset/limit provided
  if (args.offset !== undefined || args.limit !== undefined) {
    const lines = text.split('\n')
    const start = Math.max(0, (args.offset ?? 1) - 1) // 1-based to 0-based
    const count = args.limit ?? lines.length
    const sliced = lines.slice(start, start + count)
    // Prefix with line numbers for context
    text = sliced
      .map((line, i) => `${start + i + 1}: ${line}`)
      .join('\n')
    if (start + count < lines.length) {
      text += `\n... (${lines.length - start - count} more lines)`
    }
  }

  return truncate(text, MAX_FILE)
}

function actionWrite(args: NormalizedFilesArgs, ctx: FilesToolContext): string {
  const filesToWrite: Array<Record<string, unknown>> = Array.isArray(args.files)
    ? args.files
    : [{ path: args.path, content: args.content }]

  const results: string[] = []

  for (const file of filesToWrite) {
    const targetPath = getEntryPath(file)
    if (!targetPath) continue

    const blocked = enforceAccess(targetPath, ctx.cwd, ctx.fileAccessPolicy)
    if (blocked) {
      results.push(`Error (${targetPath}): ${blocked}`)
      continue
    }

    const fileContent = getEntryContent(file) ?? ''

    // Directory creation: paths ending with / or \
    if (/[\\/]$/.test(targetPath)) {
      const resolvedDir = resolveFilePath(ctx.cwd, targetPath, ctx.filesystemScope)
      fs.mkdirSync(resolvedDir, { recursive: true })
      results.push(`Created directory ${targetPath}`)
      continue
    }

    const resolved = resolveFilePath(ctx.cwd, targetPath, ctx.filesystemScope)
    fs.mkdirSync(path.dirname(resolved), { recursive: true })

    if (args.encoding === 'base64' && typeof fileContent === 'string') {
      const buf = Buffer.from(fileContent, 'base64')
      fs.writeFileSync(resolved, buf)
      results.push(`Written ${targetPath} (${buf.length} bytes, binary)`)
    } else {
      fs.writeFileSync(resolved, fileContent, 'utf-8')
      results.push(`Written ${targetPath} (${fileContent.length} bytes)`)
    }
  }

  return results.join('\n') || 'Error: no files to write.'
}

function actionEdit(args: NormalizedFilesArgs, ctx: FilesToolContext): string {
  const target = args.path
  if (!target) return 'Error: path is required for edit action.'

  const blocked = enforceAccess(target, ctx.cwd, ctx.fileAccessPolicy)
  if (blocked) return `Error: ${blocked}`

  if (args.oldString === undefined) return 'Error: old_string is required for edit action.'
  if (args.newString === undefined) return 'Error: new_string is required for edit action.'

  const resolved = resolveFilePath(ctx.cwd, target, ctx.filesystemScope)
  if (!fs.existsSync(resolved)) return `Error: File not found: ${target}`

  const content = fs.readFileSync(resolved, 'utf-8')
  const count = content.split(args.oldString).length - 1

  if (count === 0) {
    return `Error: Exact match for old_string not found in ${target}. Use action="read" to check current content.`
  }
  if (count > 1) {
    return `Error: Multiple matches (${count}) found for old_string. Provide more surrounding context for a unique match.`
  }

  const updated = content.replace(args.oldString, args.newString)
  fs.writeFileSync(resolved, updated, 'utf-8')
  return `Successfully updated ${target} (1 replacement made).`
}

function actionList(args: NormalizedFilesArgs, ctx: FilesToolContext): string {
  const target = args.path || '.'
  const maxDepth = Math.min(Math.max(args.depth ?? 3, 1), 10)

  const blocked = enforceAccess(target, ctx.cwd, ctx.fileAccessPolicy)
  if (blocked) return `Error: ${blocked}`

  const resolved = resolveFilePath(ctx.cwd, target, ctx.filesystemScope)
  const tree = listDirRecursive(resolved, 0, maxDepth)
  return tree.length ? tree.join('\n') : '(empty directory)'
}

function actionSearch(args: NormalizedFilesArgs, ctx: FilesToolContext): string {
  const query = args.query
  if (!query) return 'Error: query is required for search action.'

  const target = args.path || '.'
  const blocked = enforceAccess(target, ctx.cwd, ctx.fileAccessPolicy)
  if (blocked) return `Error: ${blocked}`

  const resolved = resolveFilePath(ctx.cwd, target, ctx.filesystemScope)

  let regex: RegExp
  try {
    regex = new RegExp(query, 'i')
  } catch {
    // Fall back to literal search if the query is not a valid regex
    regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i')
  }

  const includeGlob = args.include
  const results: string[] = []
  const maxResults = 200

  searchDir(resolved, resolved, regex, includeGlob, results, maxResults, 0, 10)

  if (results.length === 0) return `No matches found for "${query}" in ${target}`
  const output = results.join('\n')
  return truncate(output, MAX_OUTPUT)
}

/**
 * Recursively search directory for files matching the query.
 */
function searchDir(
  root: string,
  dir: string,
  regex: RegExp,
  includeGlob: string | undefined,
  results: string[],
  maxResults: number,
  depth: number,
  maxDepth: number,
): void {
  if (depth > maxDepth || results.length >= maxResults) return

  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }

  for (const entry of entries) {
    if (results.length >= maxResults) return
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue

    const fullPath = path.join(dir, entry.name)

    if (entry.isDirectory()) {
      searchDir(root, fullPath, regex, includeGlob, results, maxResults, depth + 1, maxDepth)
      continue
    }

    if (!entry.isFile()) continue

    // Apply include glob filter (simple extension/suffix matching)
    if (includeGlob && !matchSimpleGlob(entry.name, includeGlob)) continue

    // Skip binary files
    const ext = path.extname(entry.name).toLowerCase()
    if (BINARY_EXTENSIONS.has(ext)) continue

    let fileContent: string
    try {
      const buf = fs.readFileSync(fullPath)
      // Quick binary check on first 512 bytes
      const sample = buf.subarray(0, Math.min(buf.length, 512))
      let isBinary = false
      for (const byte of sample) {
        if (byte === 0) { isBinary = true; break }
      }
      if (isBinary) continue
      fileContent = buf.toString('utf-8')
    } catch {
      continue
    }

    const relativePath = path.relative(root, fullPath)
    const lines = fileContent.split('\n')
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= maxResults) return
      if (regex.test(lines[i])) {
        results.push(`${relativePath}:${i + 1}: ${lines[i].trimEnd()}`)
      }
    }
  }
}

/**
 * Simple glob matching for include filters.
 * Supports: "*.ts", "*.{ts,tsx}", "test_*", exact names.
 */
function matchSimpleGlob(filename: string, glob: string): boolean {
  // Handle brace expansion: *.{ts,tsx} -> check each extension
  const braceMatch = glob.match(/^(.+)\.\{([^}]+)\}$/)
  if (braceMatch) {
    const prefix = braceMatch[1]
    const extensions = braceMatch[2].split(',').map((e) => e.trim())
    for (const ext of extensions) {
      if (matchSimpleGlob(filename, `${prefix}.${ext}`)) return true
    }
    return false
  }

  // Convert simple glob to regex
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  try {
    return new RegExp(`^${escaped}$`, 'i').test(filename)
  } catch {
    return filename === glob
  }
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function executeFilesAction(
  rawArgs: Record<string, unknown>,
  ctx: FilesToolContext,
): Promise<string> {
  const args = normalizeArgs(rawArgs)

  log.info(TAG, `action=${args.action ?? 'inferred'} path=${args.path ?? '(none)'}`)

  try {
    switch (args.action) {
      case 'read':
        return actionRead(args, ctx)
      case 'write':
        return actionWrite(args, ctx)
      case 'edit':
        return actionEdit(args, ctx)
      case 'list':
        return actionList(args, ctx)
      case 'search':
        return actionSearch(args, ctx)
      default:
        return `Error: Unknown action "${String(args.action)}". Valid actions: read, write, edit, list, search.`
    }
  } catch (err: unknown) {
    const msg = errorMessage(err)
    if (msg === 'Path traversal not allowed') {
      if (ctx.filesystemScope === 'workspace') {
        return 'Error: target path is outside the session workspace. Use a relative path (e.g., "src/app/globals.css" instead of "/projectname/src/app/globals.css"). The files tool only accesses paths under the workspace root.'
      }
      return 'Error: target path is blocked by the current filesystem policy.'
    }
    return `Error: ${msg}`
  }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

const FilesExtension: Extension = {
  name: 'Core Files',
  description: 'Consolidated file operations: read, write, edit, list, and search.',
  hooks: {
    getCapabilityDescription: () =>
      'I can manage files with the `files` tool. ' +
      'Actions: `read` (view contents with optional line range), ' +
      '`write` (create/overwrite files), ' +
      '`edit` (surgical find-and-replace), ' +
      '`list` (directory tree), ' +
      '`search` (grep-like content search).',
    getOperatingGuidance: () => [
      'Use `{"action":"list","path":"."}` to inspect the workspace structure.',
      'Use `{"action":"read","path":"src/index.ts"}` to read a file. Add `offset` and `limit` for large files.',
      'Use `{"action":"write","path":"output.txt","content":"..."}` to create or overwrite a file.',
      'Use `{"action":"edit","path":"src/index.ts","old_string":"foo","new_string":"bar"}` for surgical edits without rewriting the whole file.',
      'Use `{"action":"search","path":"src/","query":"TODO","include":"*.ts"}` to find patterns across files.',
      'If a call fails, correct the arguments and retry. Do not conclude the workspace is inaccessible until an explicit attempt fails.',
    ],
  } as ExtensionHooks,
  tools: [
    {
      name: 'files',
      description:
        'Consolidated file operations tool. ' +
        'Actions: read (view file, optional offset/limit for line ranges), ' +
        'write (create/overwrite, supports bulk via files[]), ' +
        'edit (surgical old_string->new_string replacement), ' +
        'list (directory tree with depth control), ' +
        'search (grep-like content search with include glob filter).',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['read', 'write', 'edit', 'list', 'search'] },
          path: { type: 'string', description: 'Target file or directory path' },
          content: { type: 'string', description: 'File content (write action)' },
          old_string: { type: 'string', description: 'Exact text to find (edit action)' },
          new_string: { type: 'string', description: 'Replacement text (edit action)' },
          offset: { type: 'number', description: 'Start line number, 1-based (read action)' },
          limit: { type: 'number', description: 'Max lines to return (read action)' },
          depth: { type: 'number', description: 'Max directory depth (list action, default 3)' },
          query: { type: 'string', description: 'Search pattern/regex (search action)' },
          include: { type: 'string', description: 'File glob filter, e.g. "*.ts" (search action)' },
          encoding: { type: 'string', enum: ['utf-8', 'base64'] },
          files: {
            type: 'array',
            items: {
              type: 'object',
              properties: { path: { type: 'string' }, content: { type: 'string' } },
            },
            description: 'Bulk file writes',
          },
        },
        required: ['action'],
      },
      execute: async (args, context) =>
        executeFilesAction(
          args as Record<string, unknown>,
          { cwd: context.session?.cwd || process.cwd() },
        ),
    },
  ],
}

registerNativeCapability('files', FilesExtension)

// ---------------------------------------------------------------------------
// Tool builder (called from session-tools/index.ts)
// ---------------------------------------------------------------------------

export function buildFilesTools(bctx: ToolBuildContext) {
  if (!bctx.hasExtension('files')) return []

  return [
    tool(
      async (args) =>
        executeFilesAction(args, {
          cwd: bctx.cwd,
          filesystemScope: bctx.filesystemScope,
          fileAccessPolicy: bctx.fileAccessPolicy,
        }),
      {
        name: 'files',
        description: FilesExtension.tools![0].description,
        schema: z.object({}).passthrough(),
      },
    ),
  ]
}
