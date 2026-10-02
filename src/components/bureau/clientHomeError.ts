import { ApiRequestError, apiErrorMessage } from '@/lib/apiFetch';

/**
 * The user-facing message when the bureau client-home load fails. A 404 from
 * /api/bureau/client/[companyId] means the companyId is not in the caller's
 * bureau set, so show the bureau-specific copy; anything else shows the
 * server's own message when it sent one, else a plain sentence.
 */
export function bureauClientErrorMessage(err: unknown): string {
  if (err instanceof ApiRequestError && err.status === 404) return 'This client is not in your bureau.';
  return apiErrorMessage(err, 'Could not load this client - try again');
}
