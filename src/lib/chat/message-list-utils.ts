export function shouldShowDateSeparator(currentTime?: number, previousTime?: number): boolean {
  if (typeof currentTime !== 'number' || !Number.isFinite(currentTime) || currentTime <= 0) return false
  if (typeof previousTime !== 'number' || !Number.isFinite(previousTime) || previousTime <= 0) return true
  return new Date(currentTime).toDateString() !== new Date(previousTime).toDateString()
}
