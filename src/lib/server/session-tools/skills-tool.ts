/**
 * skills — Lightweight skill file reader.
 *
 * Agents call this tool to discover and load skill files (markdown docs)
 * that teach them how to use tools, APIs, or workflows. Two directories
 * are scanned: `skills/` (built-in, checked into the repo) and
 * `data/skills/` (user-created at runtime).
 *
 * Actions:
 *   read   — load a skill file by name
 *   list   — browse available skills with descriptions
 *   search — find skills by keyword match in content
 */

import fs from 'fs'
import path from 'path'
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import type { Extension, ExtensionHooks } from '@/types'
import { registerNativeCapability } from '../native-capabilities'
import { errorMessage } from '@/lib/shared-utils'
import { log } from '../logger'
import { normalizeToolInputArgs } from './normalize-tool-args'
import type { ToolBuildContext } from './context'
import { truncate, MAX_OUTPUT } from './context'

const TAG = 'skills-tool'

// ---------------------------------------------------------------------------
// Skill directory resolution
// ---------------------------------------------------------------------------

/** Root of the project — two levels above `src/lib/server/session-tools/` */
function projectRoot(): string {
  return path.resolve(__dirname, '..', '..', '..', '..')
}

function builtinSkillsDir(): string {
  return path.join(projectRoot(), 'skills')
}

function userSkillsDir(): string {
  return path.join(projectRoot(), 'data', 'skills')
}

// ---------------------------------------------------------------------------
// Skill file discovery
// ---------------------------------------------------------------------------

interface SkillEntry {
  name: string
  description: string
  source: 'builtin' | 'user'
  filePath: string
}

/**
 * Extract the first non-empty, non-frontmatter, non-heading content line
 * from a markdown file to use as a short description.
 */
function extractDescription(content: string): string {
  let inFrontmatter = false
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim()
    if (line === '---') {
      inFrontmatter = !inFrontmatter
      continue
    }
    if (inFrontmatter) continue
    if (!line || line.startsWith('#')) continue
    return line.length > 120 ? line.slice(0, 117) + '...' : line
  }
  return ''
}

/**
 * Walk a skills directory and collect all `.md` files as skill entries.
 * Supports both flat files (`skills/swarmclaw.md`) and directory-based
 * skills (`skills/github/SKILL.md`).
 */
function discoverSkillsInDir(dir: string, source: 'builtin' | 'user'): SkillEntry[] {
  if (!fs.existsSync(dir)) return []

  const entries: SkillEntry[] = []

  try {
    const items = fs.readdirSync(dir, { withFileTypes: true })

    for (const item of items) {
      if (item.name.startsWith('.')) continue

      const fullPath = path.join(dir, item.name)

      if (item.isFile() && item.name.endsWith('.md')) {
        // Flat markdown file: skills/swarmclaw.md
        const name = item.name.replace(/\.md$/i, '')
        const content = readFileSafe(fullPath)
        entries.push({
          name,
          description: extractDescription(content),
          source,
          filePath: fullPath,
        })
      } else if (item.isDirectory()) {
        // Directory-based skill: walk subdirectory for .md files
        const subItems = readdirSafe(fullPath)
        for (const sub of subItems) {
          if (sub.startsWith('.')) continue
          const subPath = path.join(fullPath, sub)

          if (sub.endsWith('.md') && fs.statSync(subPath).isFile()) {
            const subName = sub === 'SKILL.md'
              ? item.name
              : `${item.name}/${sub.replace(/\.md$/i, '')}`
            const content = readFileSafe(subPath)
            entries.push({
              name: subName,
              description: extractDescription(content),
              source,
              filePath: subPath,
            })
          } else if (fs.statSync(subPath).isDirectory()) {
            // One level deeper: skills/tools/files.md
            const deepItems = readdirSafe(subPath)
            for (const deep of deepItems) {
              if (deep.startsWith('.') || !deep.endsWith('.md')) continue
              const deepPath = path.join(subPath, deep)
              if (!fs.statSync(deepPath).isFile()) continue
              const deepName = `${item.name}/${sub}/${deep.replace(/\.md$/i, '')}`
              const content = readFileSafe(deepPath)
              entries.push({
                name: deepName,
                description: extractDescription(content),
                source,
                filePath: deepPath,
              })
            }
          }
        }

        // If SKILL.md or named .md exist but weren't caught by the loop
        // (they would have been), this is just for safety — dedup by filePath later
      }
    }
  } catch (err: unknown) {
    log.warn(TAG, `Failed to scan skill directory: ${dir}`, { error: errorMessage(err) })
  }

  return entries
}

function readdirSafe(dir: string): string[] {
  try {
    return fs.readdirSync(dir).filter((name) => !name.startsWith('.'))
  } catch {
    return []
  }
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8')
  } catch {
    return ''
  }
}

function discoverAllSkills(): SkillEntry[] {
  const builtin = discoverSkillsInDir(builtinSkillsDir(), 'builtin')
  const user = discoverSkillsInDir(userSkillsDir(), 'user')

  // Dedup by filePath
  const seen = new Set<string>()
  const deduped: SkillEntry[] = []
  for (const entry of [...builtin, ...user]) {
    if (seen.has(entry.filePath)) continue
    seen.add(entry.filePath)
    deduped.push(entry)
  }

  return deduped
}

// ---------------------------------------------------------------------------
// Action: read
// ---------------------------------------------------------------------------

function resolveSkillFile(name: string): SkillEntry | null {
  const skills = discoverAllSkills()
  const normalized = name.trim().toLowerCase()

  // Exact match by name
  const exact = skills.find((s) => s.name.toLowerCase() === normalized)
  if (exact) return exact

  // Partial match: name ends with the query
  const partial = skills.find((s) => s.name.toLowerCase().endsWith(normalized))
  if (partial) return partial

  // Partial match: name contains the query
  const contains = skills.find((s) => s.name.toLowerCase().includes(normalized))
  if (contains) return contains

  return null
}

function actionRead(name: string): string {
  if (!name) {
    return 'Error: `name` parameter is required for action "read". Provide the skill name to load.'
  }

  const skill = resolveSkillFile(name)
  if (!skill) {
    const available = discoverAllSkills().map((s) => s.name)
    return JSON.stringify({
      error: `Skill "${name}" not found.`,
      available: available.slice(0, 20),
      hint: 'Use action="list" to see all available skills, or action="search" with a query.',
    })
  }

  const content = readFileSafe(skill.filePath)
  if (!content) {
    return `Error: Skill file "${skill.filePath}" exists but could not be read.`
  }

  log.info(TAG, `Read skill: ${skill.name}`, { source: skill.source, filePath: skill.filePath })

  return truncate(content, MAX_OUTPUT)
}

// ---------------------------------------------------------------------------
// Action: list
// ---------------------------------------------------------------------------

function actionList(): string {
  const skills = discoverAllSkills()

  if (skills.length === 0) {
    return JSON.stringify({
      skills: [],
      message: 'No skill files found. Create .md files in skills/ or data/skills/ to add skills.',
    })
  }

  const listing = skills.map((s) => ({
    name: s.name,
    description: s.description,
    source: s.source,
  }))

  return JSON.stringify({ skills: listing, total: listing.length })
}

// ---------------------------------------------------------------------------
// Action: search
// ---------------------------------------------------------------------------

function actionSearch(query: string): string {
  if (!query) {
    return 'Error: `query` parameter is required for action "search".'
  }

  const skills = discoverAllSkills()
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)

  const results: Array<{ name: string; description: string; source: string; matchCount: number }> = []

  for (const skill of skills) {
    const content = readFileSafe(skill.filePath).toLowerCase()
    const nameAndDesc = `${skill.name} ${skill.description}`.toLowerCase()

    let matchCount = 0
    for (const term of terms) {
      if (nameAndDesc.includes(term)) matchCount += 2
      else if (content.includes(term)) matchCount += 1
    }

    if (matchCount > 0) {
      results.push({
        name: skill.name,
        description: skill.description,
        source: skill.source,
        matchCount,
      })
    }
  }

  results.sort((a, b) => b.matchCount - a.matchCount)

  return JSON.stringify({
    query,
    results: results.slice(0, 15),
    total: results.length,
  })
}

// ---------------------------------------------------------------------------
// Main action dispatcher
// ---------------------------------------------------------------------------

function executeSkillsAction(rawArgs: Record<string, unknown>): string {
  const normalized = normalizeToolInputArgs(rawArgs)
  const action = typeof normalized.action === 'string' ? normalized.action.trim().toLowerCase() : ''
  const name = typeof normalized.name === 'string' ? normalized.name.trim() : ''
  const query = typeof normalized.query === 'string' ? normalized.query.trim() : ''

  try {
    switch (action) {
      case 'read':
        return actionRead(name || query)
      case 'list':
        return actionList()
      case 'search':
        return actionSearch(query || name)
      default:
        return `Error: Unknown action "${action}". Supported actions: read, list, search.`
    }
  } catch (err: unknown) {
    return `Error: ${errorMessage(err)}`
  }
}

// ---------------------------------------------------------------------------
// Extension registration
// ---------------------------------------------------------------------------

const SkillsExtension: Extension = {
  name: 'Core Skills',
  description: 'Discover and load skill files that teach agents how to use tools, APIs, and workflows.',
  hooks: {
    getCapabilityDescription: () =>
      'I can discover and read skill files with the `skills` tool. ' +
      'Skills are markdown documents that teach me how to use specific tools, APIs, or workflows. ' +
      'Built-in skills live in `skills/` and user-created skills in `data/skills/`.',
    getOperatingGuidance: () =>
      'Use `skills` with action="list" to see what skills are available. ' +
      'Use action="read" with a name to load a specific skill. ' +
      'Use action="search" with a query to find skills by keyword. ' +
      'Load a skill before attempting unfamiliar tools or APIs.',
  } as ExtensionHooks,
  tools: [
    {
      name: 'skills',
      description:
        'Discover and load skill files (markdown docs) that teach how to use tools, APIs, and workflows. ' +
        'Actions: "read" (load a skill by name), "list" (browse available skills), "search" (find by keyword). ' +
        'Load a skill before attempting unfamiliar tools or APIs.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'list', 'search'],
            description: 'The action to perform',
          },
          name: {
            type: 'string',
            description: 'Skill name for action="read" (e.g., "tools/files", "swarmclaw")',
          },
          query: {
            type: 'string',
            description: 'Search query for action="search", or alternate name for action="read"',
          },
        },
        required: ['action'],
      },
      execute: async (args) => executeSkillsAction(args),
    },
  ],
}

registerNativeCapability('skills', SkillsExtension)

// ---------------------------------------------------------------------------
// Tool builder (called from session-tools/index.ts)
// ---------------------------------------------------------------------------

export function buildSkillsTools(bctx: ToolBuildContext) {
  if (!bctx.hasExtension('skills')) return []

  return [
    tool(
      async (args) => executeSkillsAction((args ?? {}) as Record<string, unknown>),
      {
        name: 'skills',
        description: SkillsExtension.tools![0].description,
        schema: z.object({
          action: z.enum(['read', 'list', 'search']).describe('The action to perform'),
          name: z.string().optional().describe('Skill name for action="read"'),
          query: z.string().optional().describe('Search query for action="search"'),
        }).passthrough(),
      },
    ),
  ]
}
