import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'

const thisFile = new URL(import.meta.url).pathname
const toolsDir = path.dirname(thisFile)
const serverDir = path.resolve(toolsDir, '..')

function readToolSource(fileName: string): string {
  return fs.readFileSync(path.join(toolsDir, `${fileName}.ts`), 'utf-8')
}

function readServerSource(fileName: string): string {
  return fs.readFileSync(path.join(serverDir, `${fileName}.ts`), 'utf-8')
}

describe('browser workflow surface', () => {
  it('advertises the higher-level browser actions in web', () => {
    const src = readToolSource('web')
    for (const action of ['read_page', 'extract_links', 'extract_form_fields', 'extract_table', 'fill_form', 'submit_form', 'scroll_until', 'download_file', 'complete_web_task']) {
      assert.equal(src.includes(`'${action}'`), true, `web.ts should expose ${action}`)
    }
  })

  it('supports the shorthand form-map path for fill_form', () => {
    const src = readToolSource('web')
    assert.equal(src.includes('params.form'), true)
    assert.equal(src.includes('fields is required for fill_form.'), true)
  })

  it('flags pages that require human-provided input', () => {
    const src = readToolSource('web')
    assert.equal(src.includes("type: 'human_input_required'"), true)
    assert.equal(src.includes('Ask the human instead of guessing'), true)
  })
})

describe('durable wait surface', () => {
  it('advertises the durable wait actions in monitor', () => {
    const src = readToolSource('monitor')
    for (const action of ['wait_until', 'wait_for_http', 'wait_for_file', 'wait_for_task', 'wait_for_webhook', 'wait_for_page_change']) {
      assert.equal(src.includes(`'${action}'`), true, `monitor.ts should expose ${action}`)
    }
    assert.equal(src.includes('createDurableWatch'), true)
  })

  it('routes schedule_wake through durable watch storage', () => {
    const src = readToolSource('schedule')
    assert.equal(src.includes('createWatchJob'), true)
    assert.equal(src.includes("type: 'time'"), true)
  })
})

describe('execute surface', () => {
  it('keeps just-bash as the sandboxed execution path with explicit host opt-in', () => {
    const src = readToolSource('execute')
    assert.equal(src.includes('just-bash'), true)
    assert.equal(src.includes('normalizeAgentExecuteConfig'), true)
    assert.equal(src.includes('persistent=true'), true)
  })
})

describe('delegation job handles', () => {
  it('exposes subagent control actions', () => {
    const src = readToolSource('delegate')
    for (const action of ['status', 'list', 'wait', 'cancel']) {
      assert.equal(src.includes(`action === '${action}'`), true, `delegate.ts should handle ${action}`)
    }
    assert.equal(src.includes('createDelegationJob'), true)
  })

  it('builds delegate context from the invoking session and uses job records', () => {
    const src = readToolSource('delegate')
    assert.equal(src.includes('buildDelegateContextFromSessionish'), true)
    assert.equal(src.includes('createDelegationJob'), true)
    assert.equal(src.includes('waitForDelegateJob'), true)
  })

  it('scheduler and daemon recover the durable autonomy jobs', () => {
    const schedulerSrc = fs.readFileSync(path.join(serverDir, 'runtime', 'scheduler.ts'), 'utf-8')
    const daemonSrc = fs.readFileSync(path.join(serverDir, 'runtime', 'daemon-state', 'core.ts'), 'utf-8')
    assert.equal(schedulerSrc.includes('processDueWatchJobs'), true)
    assert.equal(daemonSrc.includes('recoverStaleDelegationJobs'), true)
  })
})

describe('primitive extension surfaces', () => {
  it('advertises mailbox and human-loop actions', () => {
    const mailboxSrc = readToolSource('mailbox')
    const humanSrc = readToolSource('human-loop')
    for (const action of ['list_messages', 'list_threads', 'search_messages', 'read_message', 'download_attachment', 'reply', 'wait_for_email']) {
      assert.equal(mailboxSrc.includes(`'${action}'`), true, `mailbox.ts should expose ${action}`)
    }
    for (const action of ['request_input', 'wait_for_reply', 'list_mailbox', 'ack_mailbox', 'status']) {
      assert.equal(humanSrc.includes(`'${action}'`), true, `human-loop.ts should expose ${action}`)
    }
  })

  it('registers the primitive extensions in builtin-extensions', () => {
    const src = readServerSource('builtin-extensions')
    for (const moduleName of ['mailbox', 'human-loop']) {
      assert.equal(src.includes(`session-tools/${moduleName}`), true, `builtin-extensions.ts should import ${moduleName}`)
    }
  })
})
