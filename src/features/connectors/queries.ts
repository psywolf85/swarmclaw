import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/app/api-client'
import type {
  Connector,
  ConnectorAccessMutationAction,
  ConnectorAccessMutationResponse,
  ConnectorAccessSnapshot,
} from '@/types'

type QueryOptions = {
  enabled?: boolean
  refetchInterval?: number | false
}

interface SaveConnectorInput {
  id?: string | null
  payload: Record<string, unknown>
}

async function invalidateConnectorQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: connectorQueryKeys.all })
}

export const connectorQueryKeys = {
  all: ['connectors'] as const,
  list: () => ['connectors', 'list'] as const,
  detail: (id: string) => ['connectors', 'detail', id] as const,
  access: (id: string) => ['connectors', 'access', id] as const,
}

export function useConnectorsQuery(options: QueryOptions = {}) {
  return useQuery<Record<string, Connector>>({
    queryKey: connectorQueryKeys.list(),
    queryFn: () => api<Record<string, Connector>>('GET', '/connectors'),
    enabled: options.enabled,
    staleTime: 10_000,
  })
}

export function useConnectorQuery(id: string | null | undefined, options: QueryOptions = {}) {
  return useQuery<Connector>({
    queryKey: connectorQueryKeys.detail(id || 'unknown'),
    queryFn: () => api<Connector>('GET', `/connectors/${id}`),
    enabled: Boolean(id) && options.enabled !== false,
    staleTime: 2_000,
    refetchInterval: options.refetchInterval,
  })
}

export function useConnectorAccessQuery(id: string | null | undefined, options: QueryOptions = {}) {
  return useQuery<ConnectorAccessSnapshot>({
    queryKey: connectorQueryKeys.access(id || 'unknown'),
    queryFn: () => api<ConnectorAccessSnapshot>('GET', `/connectors/${id}/access`),
    enabled: Boolean(id) && options.enabled !== false,
    staleTime: 5_000,
  })
}

export function useConnectorDoctorMutation() {
  return useMutation({
    mutationFn: (payload: Record<string, unknown>) =>
      api<{
        warnings?: string[]
        policy?: Record<string, unknown> | null
      }>('POST', '/connectors/doctor', payload),
  })
}

export function useSaveConnectorMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, payload }: SaveConnectorInput) =>
      id ? api('PUT', `/connectors/${id}`, payload) : api('POST', '/connectors', payload),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        invalidateConnectorQueries(queryClient),
        variables.id
          ? queryClient.invalidateQueries({ queryKey: connectorQueryKeys.detail(variables.id) })
          : Promise.resolve(),
      ])
    },
  })
}

export function useConnectorActionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ id, action }: { id: string; action: string }) =>
      api('PUT', `/connectors/${id}`, { action }),
    onSuccess: async (_data, variables) => {
      await Promise.all([
        invalidateConnectorQueries(queryClient),
        queryClient.invalidateQueries({ queryKey: connectorQueryKeys.detail(variables.id) }),
      ])
    },
  })
}

export function useDeleteConnectorMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api('DELETE', `/connectors/${id}`),
    onSuccess: async (_data, id) => {
      await Promise.all([
        invalidateConnectorQueries(queryClient),
        queryClient.removeQueries({ queryKey: connectorQueryKeys.detail(id) }),
        queryClient.removeQueries({ queryKey: connectorQueryKeys.access(id) }),
      ])
    },
  })
}

export function useConnectorAccessMutation(id: string | null | undefined) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      action,
      senderId,
      senderIdAlt,
      code,
      dmAddressingMode,
    }: {
      action: ConnectorAccessMutationAction
      senderId?: string | null
      senderIdAlt?: string | null
      code?: string | null
      dmAddressingMode?: 'open' | 'addressed' | null
    }) => api<ConnectorAccessMutationResponse>('PUT', `/connectors/${id}/access`, {
      action,
      senderId: senderId || null,
      senderIdAlt: senderIdAlt || null,
      code: code || null,
      dmAddressingMode: dmAddressingMode || null,
    }),
    onSuccess: async (result) => {
      if (id) {
        queryClient.setQueryData(connectorQueryKeys.access(id), result.snapshot)
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: connectorQueryKeys.detail(id) }),
          invalidateConnectorQueries(queryClient),
        ])
      }
    },
  })
}
