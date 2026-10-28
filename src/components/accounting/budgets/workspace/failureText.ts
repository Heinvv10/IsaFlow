import type { ApiFailure } from './types';

/** One line for the user from a failed budget request; rate-limit and busy answers say when to retry. */
export function failureText(f: ApiFailure): string {
  if ((f.kind === 'rateLimited' || f.kind === 'busy') && f.retryAfter !== null) return `${f.message} Try again in ${f.retryAfter} s.`;
  return f.message;
}
