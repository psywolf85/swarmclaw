import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/app/api-client'
import type {
  ClawHubSkill,
  Skill,
  SkillInvocationConfig,
  SkillCommandDispatch,
  SkillSuggestion,
} from '@/types'

type QueryOptions = {
  enabled?: boolean
}

export interface ClawHubSearchResponse {
  skills: ClawHubSkill[]
  total: number
  page: number
  nextCursor?: string | null
  error?: string
}

export type ClawHubPreview = Partial<Skill> & {
  name: string
  content: string
  description?: string
  invocation?: SkillInvocationConfig | null
  commandDispatch?: SkillCommandDispatch | null
}

async function invalidateSkillQueries(queryClient: ReturnType<typeof useQueryClient>) {
  await queryClient.invalidateQueries({ queryKey: skillQueryKeys.all })
}

export const skillQueryKeys = {
  all: ['skills'] as const,
}

export const skillSuggestionQueryKeys = {
  all: ['skill-suggestions'] as const,
}

export function useSkillsQuery(options: QueryOptions = {}) {
  return useQuery<Record<string, Skill>>({
    queryKey: skillQueryKeys.all,
    queryFn: () => api<Record<string, Skill>>('GET', '/skills'),
    enabled: options.enabled,
    staleTime: 20_000,
  })
}

export function useSkillSuggestionsQuery(options: QueryOptions = {}) {
  return useQuery<SkillSuggestion[]>({
    queryKey: skillSuggestionQueryKeys.all,
    queryFn: () => api<SkillSuggestion[]>('GET', '/skill-suggestions'),
    enabled: options.enabled,
    staleTime: 20_000,
  })
}

export function useImportSkillFromUrlMutation() {
  return useMutation({
    mutationFn: (url: string) =>
      api<Partial<Skill> & { name: string; filename: string; description?: string; content: string; sourceFormat?: 'openclaw' | 'plain' }>(
        'POST',
        '/skills/import',
        { url },
      ),
  })
}

export function useSaveSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      id,
      data,
    }: {
      id?: string | null
      data: Record<string, unknown>
    }) => (id ? api('PUT', `/skills/${id}`, data) : api('POST', '/skills', data)),
    onSuccess: async () => {
      await invalidateSkillQueries(queryClient)
    },
  })
}

export function useDeleteSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api('DELETE', `/skills/${id}`),
    onSuccess: async () => {
      await invalidateSkillQueries(queryClient)
    },
  })
}

export function useGenerateSkillSuggestionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (sessionId: string) => api<SkillSuggestion>('POST', '/skill-suggestions', { sessionId }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: skillSuggestionQueryKeys.all })
    },
  })
}

export function useApproveSkillSuggestionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api('POST', `/skill-suggestions/${id}/approve`),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: skillSuggestionQueryKeys.all }),
        invalidateSkillQueries(queryClient),
      ])
    },
  })
}

export function useRejectSkillSuggestionMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api('POST', `/skill-suggestions/${id}/reject`),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: skillSuggestionQueryKeys.all })
    },
  })
}

export function useClawHubSearchMutation() {
  return useMutation({
    mutationFn: ({
      query,
      page,
      limit,
      cursor,
    }: {
      query: string
      page: number
      limit: number
      cursor?: string | null
    }) => {
      const params = new URLSearchParams({
        q: query,
        page: String(page),
        limit: String(limit),
      })
      if (cursor) params.set('cursor', cursor)
      return api<ClawHubSearchResponse>('GET', `/clawhub/search?${params.toString()}`)
    },
  })
}

export function useClawHubPreviewMutation() {
  return useMutation({
    mutationFn: (payload: {
      name: string
      description?: string
      author?: string
      tags?: string[]
      url: string
    }) => api<ClawHubPreview>('POST', '/clawhub/preview', payload),
  })
}

export function useInstallClawHubSkillMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (payload: {
      name: string
      description?: string
      url: string
      author?: string
      tags?: string[]
      content?: string
    }) => api('POST', '/clawhub/install', payload),
    onSuccess: async () => {
      await invalidateSkillQueries(queryClient)
    },
  })
}
