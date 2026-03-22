// --- Skills ---

export interface Skill {
  id: string
  name: string
  filename: string
  content: string
  projectId?: string
  description?: string
  sourceUrl?: string
  sourceFormat?: 'openclaw' | 'plain'
  author?: string
  tags?: string[]
  version?: string
  homepage?: string
  primaryEnv?: string | null
  skillKey?: string | null
  toolNames?: string[]
  capabilities?: string[]
  always?: boolean
  installOptions?: SkillInstallOption[]
  skillRequirements?: SkillRequirements
  detectedEnvVars?: string[]
  security?: SkillSecuritySummary | null
  invocation?: SkillInvocationConfig | null
  commandDispatch?: SkillCommandDispatch | null
  frontmatter?: Record<string, unknown> | null
  scope?: 'global' | 'agent'
  agentIds?: string[]
  createdAt: number
  updatedAt: number
}

export type LearnedSkillScope = 'agent' | 'session'
export type LearnedSkillLifecycle = 'candidate' | 'active' | 'shadow' | 'demoted' | 'review_ready'
export type LearnedSkillSourceKind = 'success_pattern' | 'failure_repair'
export type LearnedSkillValidationStatus = 'pending' | 'passed' | 'failed'
export type LearnedSkillRiskLevel = 'low' | 'medium' | 'high'

export interface LearnedSkill {
  id: string
  parentSkillId?: string | null
  agentId: string
  userId?: string | null
  sessionId?: string | null
  scope: LearnedSkillScope
  lifecycle: LearnedSkillLifecycle
  sourceKind: LearnedSkillSourceKind
  workflowKey: string
  failureFamily?: string | null
  objectiveSummary?: string | null
  name?: string | null
  description?: string | null
  content?: string | null
  tags?: string[]
  rationale?: string | null
  confidence?: number | null
  riskLevel?: LearnedSkillRiskLevel | null
  validationStatus: LearnedSkillValidationStatus
  validationSummary?: string | null
  validationEvidenceCount?: number
  evidenceCount?: number
  activationCount?: number
  successCount?: number
  failureCount?: number
  consecutiveSuccessCount?: number
  consecutiveFailureCount?: number
  lastSourceHash?: string | null
  lastUsedAt?: number | null
  lastSucceededAt?: number | null
  lastFailedAt?: number | null
  demotedAt?: number | null
  demotionReason?: string | null
  retryUnlockedAt?: number | null
  retryUnlockedByReflectionId?: string | null
  retryUnlockedBySkillId?: string | null
  reviewReadyAt?: number | null
  sourceSessionName?: string | null
  sourceSnippet?: string | null
  lastRefinedAt?: number | null
  refinementCount?: number
  createdAt: number
  updatedAt: number
}

export type SkillSuggestionStatus = 'draft' | 'approved' | 'rejected'

export interface SkillSuggestion {
  id: string
  status: SkillSuggestionStatus
  sourceSessionId: string
  sourceSessionName?: string | null
  sourceAgentId?: string | null
  sourceAgentName?: string | null
  sourceHash?: string | null
  sourceMessageCount?: number | null
  name: string
  description?: string
  content: string
  tags?: string[]
  confidence?: number | null
  rationale?: string | null
  summary?: string | null
  sourceSnippet?: string | null
  createdSkillId?: string | null
  approvedAt?: number | null
  rejectedAt?: number | null
  createdAt: number
  updatedAt: number
}

export interface SkillInvocationConfig {
  userInvocable?: boolean
}

export interface SkillCommandDispatch {
  kind: 'tool'
  toolName: string
  argMode?: 'raw'
}

export interface SkillAuditFinding {
  severity: 'warning' | 'error'
  code: string
  message: string
  path?: string
}

export interface SkillAuditResult {
  status: 'pass' | 'warn' | 'block'
  findings: SkillAuditFinding[]
}

export interface SkillSecuritySummary {
  level: 'low' | 'medium' | 'high'
  notes: string[]
  detectedEnvVars?: string[]
  missingDeclarations?: string[]
  installCommands?: string[]
}

// --- Skill Lifecycle (F11) ---
export interface SkillInstallOption {
  kind: 'brew' | 'node' | 'go' | 'uv' | 'download'
  label: string
  bins?: string[]
}

export interface SkillRequirements {
  bins?: string[]
  anyBins?: string[][]
  env?: string[]
  config?: string[]
  os?: string[]
}

export type SkillAllowlistMode = 'all' | 'none' | 'selected'
