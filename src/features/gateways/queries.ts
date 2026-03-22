import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/app/api-client'
import { credentialQueryKeys } from '@/features/credentials/queries'
import type {
  GatewayProfile,
  OpenClawDevicePairRequest,
  OpenClawNode,
  OpenClawNodePairRequest,
  OpenClawPairedDevice,
} from '@/types'

type QueryOptions = {
  enabled?: boolean
}

export interface GatewayDiscoveryResult {
  host: string
  port: number
  healthy: boolean
  models?: string[]
  error?: string
}

export interface GatewayRpcResponse<T> {
  ok?: boolean
  result?: T
  error?: string
}

interface NodeListResult {
  nodes?: OpenClawNode[]
}

interface PairingListResult<T> {
  pending?: T[]
  paired?: OpenClawPairedDevice[]
}

interface SaveGatewayProfileInput {
  id?: string | null
  payload: Record<string, unknown>
}

interface VerifyOpenClawDeployInput {
  endpoint: string
  token?: string
}

export interface VerifyOpenClawDeployResult {
  ok: boolean
  verify?: {
    ok: boolean
    message?: string
    error?: string
    hint?: string
    models?: string[]
  }
}

export interface RefreshGatewayTopologyResult {
  nodes: OpenClawNode[]
  nodePairings: OpenClawNodePairRequest[]
  devicePairings: OpenClawDevicePairRequest[]
  pairedDevices: OpenClawPairedDevice[]
}

async function invalidateGatewayQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: gatewayQueryKeys.all })
}

export const gatewayQueryKeys = {
  all: ['gateways'] as const,
  profiles: () => ['gateways', 'profiles'] as const,
}

export function useGatewayProfilesQuery(options: QueryOptions = {}) {
  return useQuery<GatewayProfile[]>({
    queryKey: gatewayQueryKeys.profiles(),
    queryFn: () => api<GatewayProfile[]>('GET', '/gateways'),
    enabled: options.enabled,
    staleTime: 20_000,
  })
}

export function useSaveGatewayProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: SaveGatewayProfileInput) =>
      id ? api('PUT', `/gateways/${id}`, payload) : api('POST', '/gateways', payload),
    onSuccess: async () => {
      await Promise.all([
        invalidateGatewayQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: credentialQueryKeys.all }),
      ])
    },
  })
}

export function useDeleteGatewayProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api('DELETE', `/gateways/${id}`),
    onSuccess: async () => {
      await invalidateGatewayQueries(queryClient)
    },
  })
}

export function useCloneGatewayProfileMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) => api('POST', '/gateways', payload),
    onSuccess: async () => {
      await invalidateGatewayQueries(queryClient)
    },
  })
}

export function useGatewayHealthCheckMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api('GET', `/gateways/${id}/health`),
    onSuccess: async () => {
      await invalidateGatewayQueries(queryClient)
    },
  })
}

export function useVerifyOpenClawDeployMutation() {
  return useMutation<VerifyOpenClawDeployResult, Error, VerifyOpenClawDeployInput>({
    mutationFn: ({ endpoint, token }) =>
      api<VerifyOpenClawDeployResult>('POST', '/openclaw/deploy', {
        action: 'verify',
        endpoint,
        token: token?.trim() || undefined,
      }),
  })
}

export function useCheckOpenClawGatewayMutation() {
  return useMutation({
    mutationFn: async ({
      endpoint,
      credentialId,
      token,
    }: {
      endpoint: string
      credentialId?: string | null
      token?: string | null
    }) => {
      const params = new URLSearchParams()
      params.set('endpoint', endpoint.trim() || 'http://localhost:18789')
      if (credentialId) params.set('credentialId', credentialId)
      if (token?.trim()) params.set('token', token.trim())
      return api<{ ok: boolean; models: string[]; message?: string; error?: string; hint?: string }>(
        'GET',
        `/providers/openclaw/health?${params.toString()}`,
      )
    },
  })
}

export function useDiscoverOpenClawGatewaysMutation() {
  return useMutation({
    mutationFn: () => api<{ gateways: GatewayDiscoveryResult[] }>('GET', '/openclaw/discover'),
  })
}

export function useRefreshGatewayTopologyMutation() {
  const queryClient = useQueryClient()
  return useMutation<RefreshGatewayTopologyResult, Error, string>({
    mutationFn: async (profileId) => {
      const [nodesRes, nodePairRes, devicePairRes] = await Promise.all([
        api<GatewayRpcResponse<NodeListResult>>('POST', '/openclaw/gateway', {
          method: 'node.list',
          params: { profileId },
        }),
        api<GatewayRpcResponse<PairingListResult<OpenClawNodePairRequest>>>('POST', '/openclaw/gateway', {
          method: 'node.pair.list',
          params: { profileId },
        }),
        api<GatewayRpcResponse<PairingListResult<OpenClawDevicePairRequest>>>('POST', '/openclaw/gateway', {
          method: 'device.pair.list',
          params: { profileId },
        }),
      ])

      if (nodesRes.error) throw new Error(nodesRes.error)
      if (nodePairRes.error) throw new Error(nodePairRes.error)
      if (devicePairRes.error) throw new Error(devicePairRes.error)

      const nodes = Array.isArray(nodesRes.result?.nodes) ? nodesRes.result.nodes : []
      const nodePairings = Array.isArray(nodePairRes.result?.pending) ? nodePairRes.result.pending : []
      const devicePairings = Array.isArray(devicePairRes.result?.pending) ? devicePairRes.result.pending : []
      const pairedDevices = Array.isArray(devicePairRes.result?.paired) ? devicePairRes.result.paired : []
      const stats = {
        nodeCount: nodes.length,
        connectedNodeCount: nodes.filter((node) => node.connected).length,
        pendingNodePairings: nodePairings.length,
        pairedDeviceCount: pairedDevices.length,
        pendingDevicePairings: devicePairings.length,
      }

      void api('PUT', `/gateways/${profileId}`, { stats }).catch(() => {})

      return {
        nodes,
        nodePairings,
        devicePairings,
        pairedDevices,
      }
    },
    onSuccess: async () => {
      await invalidateGatewayQueries(queryClient)
    },
  })
}

export function useGatewayPairingDecisionMutation() {
  return useMutation({
    mutationFn: ({
      profileId,
      kind,
      requestId,
      decision,
    }: {
      profileId: string
      kind: 'node' | 'device'
      requestId: string
      decision: 'approve' | 'reject'
    }) =>
      api<GatewayRpcResponse<unknown>>('POST', '/openclaw/gateway', {
        method: kind === 'node'
          ? (decision === 'approve' ? 'node.pair.approve' : 'node.pair.reject')
          : (decision === 'approve' ? 'device.pair.approve' : 'device.pair.reject'),
        params: { profileId, requestId },
      }),
  })
}

export function useGatewayRemoveDeviceMutation() {
  return useMutation({
    mutationFn: ({ profileId, deviceId }: { profileId: string; deviceId: string }) =>
      api<GatewayRpcResponse<unknown>>('POST', '/openclaw/gateway', {
        method: 'device.pair.remove',
        params: { profileId, deviceId },
      }),
  })
}

export function useGatewayInvokeNodeMutation() {
  return useMutation({
    mutationFn: ({
      profileId,
      nodeId,
      command,
      params,
    }: {
      profileId: string
      nodeId: string
      command: string
      params: Record<string, unknown>
    }) =>
      api<GatewayRpcResponse<unknown>>('POST', '/openclaw/gateway', {
        method: 'node.invoke',
        params: {
          profileId,
          nodeId,
          command,
          params,
        },
      }),
  })
}
