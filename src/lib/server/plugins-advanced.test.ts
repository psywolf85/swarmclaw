import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalizeExtensionId,
  expandExtensionIds,
  getExtensionAliases,
  normalizeExtensionId,
  extensionIdMatches,
} from './tool-aliases'

// ---------------------------------------------------------------------------
// normalizeExtensionId
// ---------------------------------------------------------------------------
describe('normalizeExtensionId', () => {
  it('converts uppercase to lowercase', () => {
    assert.equal(normalizeExtensionId('WEB_SEARCH'), 'web_search')
  })

  it('trims leading and trailing whitespace', () => {
    assert.equal(normalizeExtensionId('  shell  '), 'shell')
  })

  it('handles combined upper + whitespace', () => {
    assert.equal(normalizeExtensionId('  WEB_SEARCH  '), 'web_search')
  })

  it('returns empty string for empty input', () => {
    assert.equal(normalizeExtensionId(''), '')
  })

  it('returns already normalized value unchanged', () => {
    assert.equal(normalizeExtensionId('files'), 'files')
  })

  it('returns empty string for non-string input (number)', () => {
    assert.equal(normalizeExtensionId(42), '')
  })

  it('returns empty string for null', () => {
    assert.equal(normalizeExtensionId(null), '')
  })

  it('returns empty string for undefined', () => {
    assert.equal(normalizeExtensionId(undefined), '')
  })
})

// ---------------------------------------------------------------------------
// canonicalizeExtensionId
// ---------------------------------------------------------------------------
describe('canonicalizeExtensionId', () => {
  it('resolves web_search → web', () => {
    assert.equal(canonicalizeExtensionId('web_search'), 'web')
  })

  it('resolves web_fetch → web', () => {
    assert.equal(canonicalizeExtensionId('web_fetch'), 'web')
  })

  it('keeps web (already canonical)', () => {
    assert.equal(canonicalizeExtensionId('web'), 'web')
  })

  it('resolves execute_command → shell', () => {
    assert.equal(canonicalizeExtensionId('execute_command'), 'shell')
  })

  it('resolves memory_tool → memory', () => {
    assert.equal(canonicalizeExtensionId('memory_tool'), 'memory')
  })

  it('resolves narrow memory tools → memory', () => {
    assert.equal(canonicalizeExtensionId('memory_search'), 'memory')
    assert.equal(canonicalizeExtensionId('memory_get'), 'memory')
    assert.equal(canonicalizeExtensionId('memory_store'), 'memory')
    assert.equal(canonicalizeExtensionId('memory_update'), 'memory')
  })

  it('keeps files (already canonical)', () => {
    assert.equal(canonicalizeExtensionId('files'), 'files')
  })

  it('returns unknown extension as-is', () => {
    assert.equal(canonicalizeExtensionId('totally_unknown'), 'totally_unknown')
  })

  it('resolves delegate_to_claude_code → delegate', () => {
    assert.equal(canonicalizeExtensionId('delegate_to_claude_code'), 'delegate')
  })

  it('resolves claude_code → delegate', () => {
    assert.equal(canonicalizeExtensionId('claude_code'), 'delegate')
  })

  it('resolves process_tool → shell', () => {
    assert.equal(canonicalizeExtensionId('process_tool'), 'shell')
  })

  it('resolves openclaw_browser → browser', () => {
    assert.equal(canonicalizeExtensionId('openclaw_browser'), 'browser')
  })

  it('returns raw string (preserving case) for empty normalized result', () => {
    // non-string input → normalizeExtensionId returns ''
    assert.equal(canonicalizeExtensionId(123), '')
  })
})

// ---------------------------------------------------------------------------
// expandExtensionIds
// ---------------------------------------------------------------------------
describe('expandExtensionIds', () => {
  it('shell implies process', () => {
    const result = expandExtensionIds(['shell'])
    assert.ok(result.includes('shell'))
    assert.ok(result.includes('process'))
  })

  it('manage_platform expands to sub-extensions', () => {
    const result = expandExtensionIds(['manage_platform'])
    const expected = [
      'manage_platform',
      'manage_agents',
      'manage_projects',
      'manage_tasks',
      'manage_schedules',
      'manage_skills',
      'manage_webhooks',
      'manage_connectors',
      'manage_sessions',
      'manage_secrets',
    ]
    for (const e of expected) {
      assert.ok(result.includes(e), `expected ${e} in expansion`)
    }
  })

  it('web expands to include web_search and web_fetch', () => {
    const result = expandExtensionIds(['web'])
    assert.ok(result.includes('web'))
    assert.ok(result.includes('web_search'))
    assert.ok(result.includes('web_fetch'))
  })

  it('removes duplicates after expansion', () => {
    const result = expandExtensionIds(['web', 'web_search', 'web_fetch'])
    const unique = new Set(result)
    assert.equal(result.length, unique.size)
  })

  it('returns empty array for empty input', () => {
    assert.deepEqual(expandExtensionIds([]), [])
  })

  it('keeps unknown extension as-is', () => {
    const result = expandExtensionIds(['my_custom_extension'])
    assert.ok(result.includes('my_custom_extension'))
  })

  it('deduplicates overlapping expansions from multiple inputs', () => {
    const result = expandExtensionIds(['web', 'web_search'])
    const counts = result.reduce<Record<string, number>>((acc, id) => {
      acc[id] = (acc[id] || 0) + 1
      return acc
    }, {})
    for (const [id, count] of Object.entries(counts)) {
      assert.equal(count, 1, `${id} appears ${count} times`)
    }
  })

  it('returns empty array for null', () => {
    assert.deepEqual(expandExtensionIds(null), [])
  })

  it('returns empty array for undefined', () => {
    assert.deepEqual(expandExtensionIds(undefined), [])
  })

  it('shell also expands aliases (execute_command, process_tool)', () => {
    const result = expandExtensionIds(['shell'])
    assert.ok(result.includes('execute_command'))
    assert.ok(result.includes('process_tool'))
  })

  it('manage_platform + shell has no duplicates', () => {
    const result = expandExtensionIds(['manage_platform', 'shell'])
    const unique = new Set(result)
    assert.equal(result.length, unique.size)
  })

  it('handles same extension requested multiple times', () => {
    const result = expandExtensionIds(['web', 'web', 'web'])
    const webCount = result.filter((id) => id === 'web').length
    assert.equal(webCount, 1)
  })
})

// ---------------------------------------------------------------------------
// getExtensionAliases
// ---------------------------------------------------------------------------
describe('getExtensionAliases', () => {
  it('web returns [web, web_search, web_fetch]', () => {
    const result = getExtensionAliases('web')
    assert.ok(result.includes('web'))
    assert.ok(result.includes('web_search'))
    assert.ok(result.includes('web_fetch'))
    assert.equal(result.length, 5) // web, web_search, web_fetch, http_request, http
  })

  it('web_search returns the same group as web', () => {
    const fromWeb = getExtensionAliases('web').sort()
    const fromAlias = getExtensionAliases('web_search').sort()
    assert.deepEqual(fromWeb, fromAlias)
  })

  it('unknown extension returns array with just the input', () => {
    assert.deepEqual(getExtensionAliases('unknown_thing'), ['unknown_thing'])
  })

  it('shell includes execute_command and process_tool', () => {
    const result = getExtensionAliases('shell')
    assert.ok(result.includes('shell'))
    assert.ok(result.includes('execute_command'))
    assert.ok(result.includes('process_tool'))
  })

  it('returns empty array for empty string', () => {
    assert.deepEqual(getExtensionAliases(''), [])
  })

  it('returns empty array for null', () => {
    assert.deepEqual(getExtensionAliases(null), [])
  })

  it('delegate group includes all delegate variants', () => {
    const result = getExtensionAliases('delegate')
    assert.ok(result.includes('claude_code'))
    assert.ok(result.includes('delegate_to_claude_code'))
    assert.ok(result.includes('codex_cli'))
    assert.ok(result.includes('delegate_to_codex_cli'))
  })
})

// ---------------------------------------------------------------------------
// extensionIdMatches
// ---------------------------------------------------------------------------
describe('extensionIdMatches', () => {
  it('web enabled, web_search matches (alias)', () => {
    assert.equal(extensionIdMatches(['web'], 'web_search'), true)
  })

  it('web_search enabled, web matches (reverse alias)', () => {
    assert.equal(extensionIdMatches(['web_search'], 'web'), true)
  })

  it('files enabled, shell does not match (different families)', () => {
    assert.equal(extensionIdMatches(['files'], 'shell'), false)
  })

  it('manage_platform enabled, manage_tasks matches (implication)', () => {
    assert.equal(extensionIdMatches(['manage_platform'], 'manage_tasks'), true)
  })

  it('empty enabled list, nothing matches', () => {
    assert.equal(extensionIdMatches([], 'web'), false)
  })

  it('case insensitive match', () => {
    assert.equal(extensionIdMatches(['WEB'], 'web_search'), true)
  })

  it('shell enabled, process matches (implication)', () => {
    assert.equal(extensionIdMatches(['shell'], 'process'), true)
  })

  it('manage_platform enabled, manage_secrets matches', () => {
    assert.equal(extensionIdMatches(['manage_platform'], 'manage_secrets'), true)
  })

  it('null enabled list returns false', () => {
    assert.equal(extensionIdMatches(null, 'web'), false)
  })

  it('undefined enabled list returns false', () => {
    assert.equal(extensionIdMatches(undefined, 'web'), false)
  })
})

// ---------------------------------------------------------------------------
// Complex expansion scenarios
// ---------------------------------------------------------------------------
describe('complex expansion scenarios', () => {
  it('shell + web + memory fully expands', () => {
    const result = expandExtensionIds(['shell', 'web', 'memory'])
    // shell family
    assert.ok(result.includes('shell'))
    assert.ok(result.includes('execute_command'))
    assert.ok(result.includes('process_tool'))
    assert.ok(result.includes('process'))
    // web family
    assert.ok(result.includes('web'))
    assert.ok(result.includes('web_search'))
    assert.ok(result.includes('web_fetch'))
    // memory family
    assert.ok(result.includes('memory'))
    assert.ok(result.includes('memory_tool'))
  })

  it('large extension list (50+ items) all expanded correctly', () => {
    const ids = Array.from({ length: 50 }, (_, i) => `custom_extension_${i}`)
    ids.push('shell', 'web')
    const result = expandExtensionIds(ids)
    // All custom ones present
    for (let i = 0; i < 50; i++) {
      assert.ok(result.includes(`custom_extension_${i}`))
    }
    // Shell expansion present
    assert.ok(result.includes('process'))
    // Web expansion present
    assert.ok(result.includes('web_fetch'))
  })

  it('alias chains do not cause infinite loops', () => {
    // delegate has many aliases; expansion should terminate
    const result = expandExtensionIds(['delegate'])
    assert.ok(result.includes('delegate'))
    assert.ok(result.includes('claude_code'))
    assert.ok(result.includes('delegate_to_claude_code'))
    // Just confirm it returned without hanging
    assert.ok(result.length > 0)
  })

  it('connector aliases expand correctly', () => {
    const result = expandExtensionIds(['manage_connectors'])
    assert.ok(result.includes('manage_connectors'))
    assert.ok(result.includes('connectors'))
    assert.ok(result.includes('connector_message_tool'))
  })

  it('sandbox aliases expand', () => {
    const result = expandExtensionIds(['sandbox'])
    assert.ok(result.includes('sandbox'))
    assert.ok(result.includes('execute'))
  })

  it('files expands to include read_file, write_file, etc.', () => {
    const result = expandExtensionIds(['files'])
    assert.ok(result.includes('read_file'))
    assert.ok(result.includes('write_file'))
    assert.ok(result.includes('list_files'))
    assert.ok(result.includes('copy_file'))
    assert.ok(result.includes('move_file'))
    assert.ok(result.includes('delete_file'))
    assert.ok(result.includes('send_file'))
  })
})
