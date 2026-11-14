// src/lib/auth/gotrueErrors.ts
// GoTrue's typed failures (moved out of gotrue.ts to keep it under 300 lines; re-exported there).

/** A non-OK verdict from the password grant. `credentialsRejected`: GoTrue's definite "wrong email or password". */
export class GoTrueSignInError extends Error {
  readonly credentialsRejected: boolean;
  constructor(readonly status: number, body: string) {
    super(`gotrue signIn failed: ${status} ${body}`);
    this.name = 'GoTrueSignInError';
    let parsed: { error_code?: unknown } | null = null;
    try { parsed = JSON.parse(body) as { error_code?: unknown }; } catch { parsed = null; /* not JSON: not a definite verdict */ }
    this.credentialsRejected = status === 400 && parsed?.error_code === 'invalid_credentials';
  }
}

/** A non-OK verdict from /logout. `errorCode`: GoTrue's `error_code`, when the body is JSON that carries one. */
export class GoTrueLogoutError extends Error {
  readonly errorCode: string | null;
  constructor(readonly status: number, body: string) {
    super(`gotrue logout failed: ${status} ${body}`);
    this.name = 'GoTrueLogoutError';
    let parsed: { error_code?: unknown } | null = null;
    try { parsed = JSON.parse(body) as { error_code?: unknown }; } catch { parsed = null; /* not JSON: no code */ }
    this.errorCode = typeof parsed?.error_code === 'string' ? parsed.error_code : null;
  }
}

/**
 * GoTrue's 403 `session_not_found` on /logout: the session named by the token no longer exists (already revoked
 * or ended), so for a revocation it is the outcome wanted, not a failure.
 */
export function isSessionAlreadyGone(err: unknown): boolean {
  return err instanceof GoTrueLogoutError && err.status === 403 && err.errorCode === 'session_not_found';
}
