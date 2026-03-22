/**
 * Standardized result type for route-facing services.
 *
 * Routes inspect `ok` to decide the HTTP status code and response body.
 */
export type ServiceResult<T> =
  | { ok: true; payload: T }
  | { ok: false; status: number; payload: { error: string } }

export function serviceOk<T>(payload: T): ServiceResult<T> {
  return { ok: true, payload }
}

export function serviceFail(status: number, error: string): ServiceResult<never> {
  return { ok: false, status, payload: { error } }
}
