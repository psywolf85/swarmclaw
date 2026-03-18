import type { LearnedSkill, RunReflection, Skill, SkillSuggestion } from '@/types'

import {
  deleteLearnedSkill as deleteStoredLearnedSkill,
  deleteSkill as deleteStoredSkill,
  deleteSkillSuggestion as deleteStoredSkillSuggestion,
  loadLearnedSkill as loadStoredLearnedSkill,
  loadLearnedSkills as loadStoredLearnedSkills,
  loadRunReflection as loadStoredRunReflection,
  loadRunReflections as loadStoredRunReflections,
  loadSkillSuggestion as loadStoredSkillSuggestion,
  loadSkillSuggestions as loadStoredSkillSuggestions,
  loadSkills as loadStoredSkills,
  patchLearnedSkill as patchStoredLearnedSkill,
  patchSkillSuggestion as patchStoredSkillSuggestion,
  saveLearnedSkills as saveStoredLearnedSkills,
  saveRunReflections as saveStoredRunReflections,
  saveSkillSuggestions as saveStoredSkillSuggestions,
  saveSkills as saveStoredSkills,
  upsertLearnedSkill as upsertStoredLearnedSkill,
  upsertRunReflection as upsertStoredRunReflection,
  upsertSkillSuggestion as upsertStoredSkillSuggestion,
  upsertStoredItem,
} from '@/lib/server/storage'
import { createRecordRepository } from '@/lib/server/persistence/repository-utils'

export const skillRepository = createRecordRepository<Skill>(
  'skills',
  {
    get(id) {
      return (loadStoredSkills() as Record<string, Skill>)[id] || null
    },
    list() {
      return loadStoredSkills() as Record<string, Skill>
    },
    upsert(id, value) {
      upsertStoredItem('skills', id, value)
    },
    replace(data) {
      saveStoredSkills(data as Record<string, Skill>)
    },
    delete(id) {
      deleteStoredSkill(id)
    },
  },
)

export const learnedSkillRepository = createRecordRepository<LearnedSkill>(
  'learned-skills',
  {
    get(id) {
      return loadStoredLearnedSkill(id) as LearnedSkill | null
    },
    list() {
      return loadStoredLearnedSkills() as Record<string, LearnedSkill>
    },
    upsert(id, value) {
      upsertStoredLearnedSkill(id, value as LearnedSkill)
    },
    replace(data) {
      saveStoredLearnedSkills(data as Record<string, LearnedSkill>)
    },
    patch(id, updater) {
      return patchStoredLearnedSkill(id, updater as (current: LearnedSkill | null) => LearnedSkill | null) as LearnedSkill | null
    },
    delete(id) {
      deleteStoredLearnedSkill(id)
    },
  },
)

export const skillSuggestionRepository = createRecordRepository<SkillSuggestion>(
  'skill-suggestions',
  {
    get(id) {
      return loadStoredSkillSuggestion(id) as SkillSuggestion | null
    },
    list() {
      return loadStoredSkillSuggestions() as Record<string, SkillSuggestion>
    },
    upsert(id, value) {
      upsertStoredSkillSuggestion(id, value as SkillSuggestion)
    },
    replace(data) {
      saveStoredSkillSuggestions(data as Record<string, SkillSuggestion>)
    },
    patch(id, updater) {
      return patchStoredSkillSuggestion(id, updater as (current: SkillSuggestion | null) => SkillSuggestion | null) as SkillSuggestion | null
    },
    delete(id) {
      deleteStoredSkillSuggestion(id)
    },
  },
)

export const runReflectionRepository = createRecordRepository<RunReflection>(
  'run-reflections',
  {
    get(id) {
      return loadStoredRunReflection(id) as RunReflection | null
    },
    list() {
      return loadStoredRunReflections() as Record<string, RunReflection>
    },
    upsert(id, value) {
      upsertStoredRunReflection(id, value as RunReflection)
    },
    replace(data) {
      saveStoredRunReflections(data as Record<string, RunReflection>)
    },
  },
)

export const loadSkills = () => skillRepository.list()
export const loadSkill = (id: string) => skillRepository.get(id)
export const saveSkills = (items: Record<string, Skill | Record<string, unknown>>) => skillRepository.replace(items as Record<string, Skill>)
export const saveSkill = (id: string, value: Skill | Record<string, unknown>) => skillRepository.upsert(id, value as Skill)
export const deleteSkill = (id: string) => skillRepository.delete(id)

export const loadLearnedSkills = () => learnedSkillRepository.list()
export const loadLearnedSkill = (id: string) => learnedSkillRepository.get(id)
export const saveLearnedSkills = (items: Record<string, LearnedSkill | Record<string, unknown>>) => learnedSkillRepository.replace(items as Record<string, LearnedSkill>)
export const upsertLearnedSkill = (id: string, value: LearnedSkill | Record<string, unknown>) => learnedSkillRepository.upsert(id, value as LearnedSkill)
export const patchLearnedSkill = (id: string, updater: (current: LearnedSkill | null) => LearnedSkill | null) => learnedSkillRepository.patch(id, updater)
export const deleteLearnedSkill = (id: string) => learnedSkillRepository.delete(id)

export const loadSkillSuggestions = () => skillSuggestionRepository.list()
export const loadSkillSuggestion = (id: string) => skillSuggestionRepository.get(id)
export const saveSkillSuggestions = (items: Record<string, SkillSuggestion | Record<string, unknown>>) => skillSuggestionRepository.replace(items as Record<string, SkillSuggestion>)
export const upsertSkillSuggestion = (id: string, value: SkillSuggestion | Record<string, unknown>) => skillSuggestionRepository.upsert(id, value as SkillSuggestion)
export const patchSkillSuggestion = (id: string, updater: (current: SkillSuggestion | null) => SkillSuggestion | null) => skillSuggestionRepository.patch(id, updater)
export const deleteSkillSuggestion = (id: string) => skillSuggestionRepository.delete(id)

export const loadRunReflections = () => runReflectionRepository.list()
export const loadRunReflection = (id: string) => runReflectionRepository.get(id)
export const saveRunReflections = (items: Record<string, RunReflection | Record<string, unknown>>) => runReflectionRepository.replace(items as Record<string, RunReflection>)
export const upsertRunReflection = (id: string, value: RunReflection | Record<string, unknown>) => runReflectionRepository.upsert(id, value as RunReflection)
