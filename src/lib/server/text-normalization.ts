/**
 * Shared text-normalization utilities.
 *
 * Consolidates the cleanText / cleanMultiline / normalizeList helpers that
 * were previously duplicated across 7+ server modules.
 */

/** Collapse whitespace, trim, and cap at `max` characters. Returns `''` for non-string input. */
export function cleanText(value: unknown, max = 320): string {
  if (typeof value !== 'string') return ''
  return value.replace(/\s+/g, ' ').trim().slice(0, max)
}

/** Trim each line, drop blanks, rejoin, and cap at `max` characters. Returns `''` for non-string input. */
export function cleanMultiline(value: unknown, max = 1_200): string {
  if (typeof value !== 'string') return ''
  return value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, max)
    .trim()
}

/** Deduplicated, cleaned list of strings from unknown input. */
export function normalizeList(input: unknown, maxItems: number, maxChars = 240): string[] {
  const values = Array.isArray(input) ? input : []
  const seen = new Set<string>()
  const out: string[] = []
  for (const value of values) {
    const cleaned = cleanText(value, maxChars)
    if (!cleaned) continue
    const key = cleaned.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(cleaned)
    if (out.length >= maxItems) break
  }
  return out
}
