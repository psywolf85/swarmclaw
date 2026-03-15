import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  getExtensionSourceLabel,
  inferExtensionInstallSourceFromUrl,
  inferExtensionPublisherSourceFromUrl,
  isMarketplaceInstallSource,
  normalizeExtensionCatalogSource,
  normalizeExtensionInstallSource,
  normalizeExtensionPublisherSource,
} from './extension-sources'

describe('extension source helpers', () => {
  it('normalizes publisher, catalog, and install source values', () => {
    assert.equal(normalizeExtensionPublisherSource('SwarmForge'), 'swarmforge')
    assert.equal(normalizeExtensionCatalogSource('swarmclaw-site'), 'swarmclaw-site')
    assert.equal(normalizeExtensionInstallSource('ClawHub'), 'clawhub')
    assert.equal(normalizeExtensionInstallSource('unknown-source'), undefined)
  })

  it('infers extension provenance from known marketplace URLs', () => {
    assert.equal(
      inferExtensionPublisherSourceFromUrl('https://raw.githubusercontent.com/swarmclawai/swarmforge/main/tool-logger.js'),
      'swarmforge',
    )
    assert.equal(
      inferExtensionInstallSourceFromUrl('https://clawhub.ai/skills/openclaw-gmail'),
      'clawhub',
    )
    assert.equal(
      inferExtensionPublisherSourceFromUrl('https://swarmclaw.ai/extensions/demo.js'),
      'swarmclaw',
    )
  })

  it('labels marketplace sources consistently', () => {
    assert.equal(isMarketplaceInstallSource('swarmclaw-site'), true)
    assert.equal(isMarketplaceInstallSource('manual'), false)
    assert.equal(getExtensionSourceLabel('swarmclaw-site'), 'SwarmClaw Site')
    assert.equal(getExtensionSourceLabel('swarmforge'), 'SwarmForge')
  })
})
