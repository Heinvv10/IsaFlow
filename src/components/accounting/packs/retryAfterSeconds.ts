/**
 * How long the server told us to wait, in whole seconds.
 *
 * `Retry-After` is optional and `apiResponse.tooManyRequests` does not
 * currently set one, so the absent case is the NORMAL case rather than an
 * error path — the message just drops the countdown. The header's HTTP-date
 * form is not read: this endpoint's limiter is a fixed window in seconds, and
 * guessing at a date form nothing sends would be untested code.
 */
export function retryAfterSeconds(headers: { get(name: string): string | null }): number | null {
  const raw = headers.get('Retry-After');
  if (raw === null) return null;
  const seconds = Number(raw.trim());
  return Number.isInteger(seconds) && seconds > 0 ? seconds : null;
}
