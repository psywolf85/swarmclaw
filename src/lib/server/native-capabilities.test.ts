import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import '@/lib/server/builtin-extensions'
import { collectCapabilityDescriptions, listNativeCapabilities } from '@/lib/server/native-capabilities'
import { getExtensionManager } from '@/lib/server/extensions'

describe('native capabilities', () => {
  it('keeps platform-owned built-ins out of ExtensionManager listings', () => {
    const extensions = getExtensionManager().listExtensions()
    const nativeIds = new Set(listNativeCapabilities().map((entry) => entry.filename))

    assert.equal(nativeIds.has('memory'), true)
    assert.equal(nativeIds.has('connectors'), true)
    assert.equal(extensions.some((entry) => entry.filename === 'memory'), false)
    assert.equal(extensions.some((entry) => entry.filename === 'connectors'), false)
    assert.equal(extensions.some((entry) => entry.filename === 'email'), true)
  })

  it('still contributes native capability descriptions to prompt assembly', () => {
    const lines = collectCapabilityDescriptions(['memory', 'connectors'])
    assert.equal(lines.some((line) => line.includes('long-term memory')), true)
    assert.equal(lines.some((line) => line.includes('manage messaging channels')), true)
  })
})
