/**
 * Derive the user-facing error message for the bureau client-home page from an
 * apiResponse error envelope. A 404 from /api/bureau/client/[companyId] means the
 * companyId is not in the caller's bureau set, so show the bureau-specific copy;
 * other failures surface the server's error.message (apiResponse nests it under
 * `error.message`, NOT top-level `message`) with a generic default.
 */
export interface ApiErrorBody {
  error?: { message?: string };
  message?: string;
}

export function bureauClientErrorMessage(status: number, body: ApiErrorBody): string {
  if (status === 404) return 'This client is not in your bureau.';
  return body.error?.message ?? body.message ?? 'Failed to load';
}
