import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createCredential, fetchCredentials } from '@/lib/chat/chats'
import type { Credentials } from '@/types'

type QueryOptions = {
  enabled?: boolean
}

export interface CreateCredentialInput {
  provider: string
  name: string
  apiKey: string
}

export const credentialQueryKeys = {
  all: ['credentials'] as const,
}

export function useCredentialsQuery(options: QueryOptions = {}) {
  return useQuery<Credentials>({
    queryKey: credentialQueryKeys.all,
    queryFn: fetchCredentials,
    enabled: options.enabled,
    staleTime: 30_000,
  })
}

export function useCreateCredentialMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ provider, name, apiKey }: CreateCredentialInput) =>
      createCredential(provider, name, apiKey),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: credentialQueryKeys.all })
    },
  })
}
