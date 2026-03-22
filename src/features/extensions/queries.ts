import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/app/api-client'

type QueryOptions = {
  enabled?: boolean
}

export interface ConnectorExtensionOption {
  id: string
  name: string
  description?: string
}

export const extensionQueryKeys = {
  all: ['extensions'] as const,
  connectorUi: () => ['extensions', 'connector-ui'] as const,
}

export function useConnectorExtensionOptionsQuery(options: QueryOptions = {}) {
  return useQuery<ConnectorExtensionOption[]>({
    queryKey: extensionQueryKeys.connectorUi(),
    queryFn: () => api<ConnectorExtensionOption[]>('GET', '/extensions/ui?type=connectors'),
    enabled: options.enabled,
    staleTime: 60_000,
  })
}
