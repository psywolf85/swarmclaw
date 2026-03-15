import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'

import type { Agent, GatewayProfile } from '@/types'
import {
  encryptKey,
  loadAgents,
  loadCredentials,
  loadGatewayProfiles,
  saveAgents,
  saveCredentials,
  saveGatewayProfiles,
} from '../storage'
import {
  disconnectAutoGateways,
  disconnectGateway,
  ensureGatewayConnected,
  hasOpenClawAgents,
  manualConnect,
  resolveGatewayConfig,
} from './gateway'

const originalCredentials = loadCredentials()
const originalGateways = loadGatewayProfiles()
const originalAgents = loadAgents({ includeTrashed: true })

afterEach(() => {
  disconnectGateway()
  saveCredentials(originalCredentials)
  saveGatewayProfiles(originalGateways)
  saveAgents(originalAgents)
})

function getGatewayState() {
  return (globalThis as Record<string, unknown>).__swarmclaw_ocgateway__ as {
    instances: Map<string, unknown>
    activeKey: string | null
    manualKeys: Set<string>
  }
}

function saveGatewayCredential(id: string, token: string) {
  const credentials = loadCredentials()
  credentials[id] = {
    id,
    provider: 'openclaw',
    name: `Credential ${id}`,
    encryptedKey: encryptKey(token),
    createdAt: Date.now(),
  }
  saveCredentials(credentials)
}

function saveGatewayProfile(profile: GatewayProfile) {
  const gateways = loadGatewayProfiles()
  gateways[profile.id] = profile
  saveGatewayProfiles(gateways)
}

test('resolveGatewayConfig uses the gateway profile wsUrl and decrypted token', () => {
  saveGatewayCredential('openclaw-cred-1', 'gateway-token-1')
  saveGatewayProfile({
    id: 'gateway-profile-1',
    name: 'Gateway 1',
    provider: 'openclaw',
    endpoint: 'http://127.0.0.1:19161/v1',
    wsUrl: 'ws://127.0.0.1:19161',
    credentialId: 'openclaw-cred-1',
    status: 'healthy',
    notes: null,
    tags: ['smoke'],
    lastError: null,
    lastCheckedAt: null,
    lastModelCount: null,
    discoveredHost: '127.0.0.1',
    discoveredPort: 19161,
    deployment: null,
    stats: null,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const resolved = resolveGatewayConfig({ profileId: 'gateway-profile-1' })
  assert.deepEqual(resolved, {
    key: 'profile:gateway-profile-1',
    profileId: 'gateway-profile-1',
    wsUrl: 'ws://127.0.0.1:19161',
    token: 'gateway-token-1',
  })
})

test('resolveGatewayConfig follows an OpenClaw agent route back to its gateway profile credential', () => {
  saveGatewayCredential('openclaw-cred-2', 'gateway-token-2')
  saveGatewayProfile({
    id: 'gateway-profile-2',
    name: 'Gateway 2',
    provider: 'openclaw',
    endpoint: 'http://127.0.0.1:19181/v1',
    wsUrl: 'ws://127.0.0.1:19181',
    credentialId: 'openclaw-cred-2',
    status: 'healthy',
    notes: null,
    tags: ['smoke'],
    lastError: null,
    lastCheckedAt: null,
    lastModelCount: null,
    discoveredHost: '127.0.0.1',
    discoveredPort: 19181,
    deployment: {
      method: 'local',
      managedBy: 'swarmclaw',
      useCase: 'local-dev',
      localInstanceId: 'smoke-app-b',
      localPort: 19181,
    },
    stats: null,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const agents = loadAgents({ includeTrashed: true })
  agents['openclaw-agent-1'] = {
    id: 'openclaw-agent-1',
    name: 'Gateway Agent',
    description: '',
    systemPrompt: '',
    provider: 'openclaw',
    model: 'default',
    credentialId: null,
    fallbackCredentialIds: [],
    apiEndpoint: null,
    gatewayProfileId: 'gateway-profile-2',
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
  saveAgents(agents)

  const resolved = resolveGatewayConfig({ agentId: 'openclaw-agent-1' })
  assert.deepEqual(resolved, {
    key: 'profile:gateway-profile-2',
    profileId: 'gateway-profile-2',
    wsUrl: 'ws://127.0.0.1:19181',
    token: 'gateway-token-2',
  })
})

test('hasOpenClawAgents ignores saved gateway profiles and disabled agents', () => {
  saveGatewayProfile({
    id: 'gateway-profile-3',
    name: 'Gateway 3',
    provider: 'openclaw',
    endpoint: 'http://127.0.0.1:19191/v1',
    wsUrl: 'ws://127.0.0.1:19191',
    credentialId: null,
    status: 'healthy',
    notes: null,
    tags: [],
    lastError: null,
    lastCheckedAt: null,
    lastModelCount: null,
    discoveredHost: null,
    discoveredPort: null,
    deployment: null,
    stats: null,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  assert.equal(hasOpenClawAgents(), false)

  const agents = loadAgents({ includeTrashed: true })
  agents['openclaw-agent-disabled'] = {
    id: 'openclaw-agent-disabled',
    name: 'Disabled Gateway Agent',
    description: '',
    systemPrompt: '',
    provider: 'openclaw',
    model: 'default',
    disabled: true,
    credentialId: null,
    fallbackCredentialIds: [],
    apiEndpoint: 'http://127.0.0.1:19191/v1',
    gatewayProfileId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
  saveAgents(agents)

  assert.equal(hasOpenClawAgents(), false)
})

test('hasOpenClawAgents includes enabled agents whose primary route resolves to OpenClaw', () => {
  saveGatewayProfile({
    id: 'gateway-profile-4',
    name: 'Gateway 4',
    provider: 'openclaw',
    endpoint: 'http://127.0.0.1:19201/v1',
    wsUrl: 'ws://127.0.0.1:19201',
    credentialId: null,
    status: 'healthy',
    notes: null,
    tags: ['economy'],
    lastError: null,
    lastCheckedAt: null,
    lastModelCount: null,
    discoveredHost: null,
    discoveredPort: null,
    deployment: null,
    stats: null,
    isDefault: true,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })

  const agents = loadAgents({ includeTrashed: true })
  agents['routed-openclaw-agent'] = {
    id: 'routed-openclaw-agent',
    name: 'Routed OpenClaw Agent',
    description: '',
    systemPrompt: '',
    provider: 'openai',
    model: 'gpt-5',
    routingStrategy: 'economy',
    credentialId: null,
    fallbackCredentialIds: [],
    gatewayProfileId: null,
    routingTargets: [
      {
        id: 'openclaw-route',
        label: 'Gateway route',
        provider: 'openclaw',
        model: 'default',
        gatewayProfileId: 'gateway-profile-4',
        role: 'economy',
      },
    ],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
  saveAgents(agents)

  assert.equal(hasOpenClawAgents(), true)
  assert.deepEqual(resolveGatewayConfig(), {
    key: 'profile:gateway-profile-4',
    profileId: 'gateway-profile-4',
    wsUrl: 'ws://127.0.0.1:19201',
    token: undefined,
  })
})

test('disconnectAutoGateways clears hidden auto-reconnect instances but preserves manual ones', async () => {
  const agents = loadAgents({ includeTrashed: true })
  agents['openclaw-agent-auto'] = {
    id: 'openclaw-agent-auto',
    name: 'Auto Gateway Agent',
    description: '',
    systemPrompt: '',
    provider: 'openclaw',
    model: 'default',
    credentialId: null,
    fallbackCredentialIds: [],
    apiEndpoint: 'http://127.0.0.1:1/v1',
    gatewayProfileId: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as Agent
  saveAgents(agents)

  assert.equal(await ensureGatewayConnected(), null)
  const stateAfterAutoConnect = getGatewayState()
  assert.equal(stateAfterAutoConnect.instances.size, 1)
  assert.equal(stateAfterAutoConnect.manualKeys.size, 0)

  disconnectAutoGateways()
  assert.equal(getGatewayState().instances.size, 0)

  assert.equal(await manualConnect('ws://127.0.0.1:1'), false)
  const stateAfterManualConnect = getGatewayState()
  assert.equal(stateAfterManualConnect.instances.size, 1)
  assert.equal(stateAfterManualConnect.manualKeys.has('__manual__'), true)

  disconnectAutoGateways()
  assert.equal(getGatewayState().instances.size, 1)
})
