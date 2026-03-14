import path from 'node:path'
import type { ClawHubBundleFile } from '@/lib/server/skills/clawhub-client'
import type { SkillAuditFinding, SkillAuditResult, SkillInstallOption, SkillRequirements } from '@/types'

const HIGH_RISK_PATTERNS: Array<{ code: string; re: RegExp; message: string }> = [
  { code: 'bootstrap_pipe', re: /\b(?:curl|wget)\b[\s\S]{0,120}\|\s*(?:bash|sh)\b/i, message: 'Detected remote bootstrap shell piping.' },
  { code: 'sudo', re: /\bsudo\b/i, message: 'Detected privileged shell command usage.' },
  { code: 'rm_rf', re: /\brm\s+-rf\b/i, message: 'Detected destructive filesystem command.' },
  { code: 'mkfs', re: /\bmkfs(?:\.[a-z0-9_-]+)?\b/i, message: 'Detected disk formatting command.' },
]

const INSTALL_HELPER_RE = /\b(?:brew install|npm install|pnpm add|yarn add|go install|uv tool install|pip install)\b/i
const ENV_VAR_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]+)/g,
  /\$\{([A-Z][A-Z0-9_]+)\}/g,
  /\bexport\s+([A-Z][A-Z0-9_]+)\b/g,
]

function unique<T>(values: T[]): T[] {
  return [...new Set(values)]
}

function normalizeBundlePath(filePath: string): string | null {
  const normalized = path.posix.normalize(filePath).replace(/\\/g, '/')
  if (!normalized || normalized === '.' || normalized.startsWith('/') || normalized.includes('\0')) return null
  if (normalized.split('/').includes('..')) return null
  return normalized
}

function detectEnvVars(content: string): string[] {
  const detected = new Set<string>()
  for (const pattern of ENV_VAR_PATTERNS) {
    let match: RegExpExecArray | null
    while ((match = pattern.exec(content)) !== null) {
      detected.add(match[1])
    }
  }
  return [...detected].sort()
}

function detectUnsafeMarkdown(content: string): boolean {
  return /\[[^\]]+\]\((?:\.\.\/|\/|file:\/\/)/i.test(content)
}

function statusForFindings(findings: SkillAuditFinding[]): SkillAuditResult['status'] {
  if (findings.some((finding) => finding.severity === 'error')) return 'block'
  if (findings.length > 0) return 'warn'
  return 'pass'
}

export function auditSkillContent(params: {
  content: string
  requirements?: SkillRequirements
  installOptions?: SkillInstallOption[]
  primaryEnv?: string | null
}): SkillAuditResult {
  const findings: SkillAuditFinding[] = []
  const content = String(params.content || '')

  for (const pattern of HIGH_RISK_PATTERNS) {
    if (!pattern.re.test(content)) continue
    findings.push({
      severity: 'error',
      code: pattern.code,
      message: pattern.message,
    })
  }

  if (detectUnsafeMarkdown(content)) {
    findings.push({
      severity: 'error',
      code: 'unsafe_markdown_path',
      message: 'Detected markdown links that traverse outside the skill root or target absolute/file URLs.',
    })
  }

  const detectedEnvVars = detectEnvVars(content)
  const declared = new Set<string>([
    ...(params.requirements?.env || []),
    ...(params.primaryEnv ? [params.primaryEnv] : []),
  ])
  const missingEnv = detectedEnvVars.filter((name) => !declared.has(name))
  if (missingEnv.length > 0) {
    findings.push({
      severity: 'warning',
      code: 'undeclared_env',
      message: `Detected env vars missing from requirements/frontmatter: ${missingEnv.join(', ')}`,
    })
  }

  if (INSTALL_HELPER_RE.test(content) || (params.installOptions?.length || 0) > 0) {
    findings.push({
      severity: 'warning',
      code: 'install_helper',
      message: 'Skill includes install helpers or bootstrap commands that should be reviewed before enabling.',
    })
  }

  return {
    status: statusForFindings(findings),
    findings: unique(findings.map((finding) => JSON.stringify(finding))).map((value) => JSON.parse(value) as SkillAuditFinding),
  }
}

export function auditSkillBundleFiles(files: ClawHubBundleFile[]): SkillAuditResult {
  const findings: SkillAuditFinding[] = []

  for (const file of files) {
    const rawPath = typeof file.path === 'string' ? file.path : ''
    if (rawPath.includes('\0')) {
      findings.push({
        severity: 'error',
        code: 'null_byte_path',
        message: 'Detected a null byte in a bundle file path.',
        path: rawPath,
      })
      continue
    }
    const normalized = normalizeBundlePath(rawPath)
    if (!normalized) {
      findings.push({
        severity: 'error',
        code: 'invalid_path',
        message: 'Bundle file path escapes the target directory or is absolute.',
        path: rawPath,
      })
      continue
    }
  }

  return {
    status: statusForFindings(findings),
    findings,
  }
}

export function mergeSkillAuditResults(...results: SkillAuditResult[]): SkillAuditResult {
  const findings = unique(
    results.flatMap((result) => result.findings).map((finding) => JSON.stringify(finding)),
  ).map((value) => JSON.parse(value) as SkillAuditFinding)
  return {
    status: statusForFindings(findings),
    findings,
  }
}
