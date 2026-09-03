// src/lib/auth/userAccountStatus.ts
/**
 * Account-standing gate for `public.users`.
 *
 * Suspending a user (adminUserActionsService.suspendUser) writes
 * `is_active = false`, `suspended_at = NOW()` and a reason, then deletes the
 * legacy `user_sessions` rows. It does NOT ban the GoTrue identity and it does
 * not revoke the access cookie — so before this guard existed a suspended user
 * holding a live session passed every membership check in the app until their
 * token expired. Suspension was advisory, not enforced.
 *
 * This module owns the single definition of "in good standing" so the cookie
 * pipeline (withAuth), the Bearer pipeline (bearerPipeline) and the
 * company-less pipeline (withUserAuth) cannot drift apart.
 *
 * ALLOW-LIST, not deny-list: every signal must affirmatively say "active".
 * `status` has no CHECK constraint and nothing in the codebase writes it, so
 * an operator setting it by hand must still lock the account out.
 */

/** The one status string that grants access. Everything else is denied. */
export const ACTIVE_USER_STATUS = 'active';

/** Uniform refusal shape for a recognised-but-suspended account. */
export const SUSPENDED_ACCOUNT_ERROR = {
  code: 'ACCOUNT_SUSPENDED',
  message: 'Your account has been suspended. Contact your administrator.',
} as const;

/** The `public.users` columns the gate reads. Nothing else is consulted. */
export interface UserAccountRow {
  is_active: boolean | null;
  status: string | null;
  /** pg returns Date for timestamptz; tests and JSON paths may carry a string. */
  suspended_at: Date | string | null;
}

/**
 * True only when the row exists and every standing signal is affirmative.
 *
 * A NULL `status` is treated as active: the column is nullable with a default
 * of 'active', and rows written before it existed carry NULL. Denying on NULL
 * would lock out real users for a column no code path writes.
 *
 * A NULL/absent row is denied by callers that can prove a profile must exist
 * (see the withAuth/bearerPipeline join). Callers that legitimately run before
 * provisioning must not use this to test for existence — see withUserAuth.
 */
export function isActiveUserAccount(row: UserAccountRow | null | undefined): boolean {
  if (!row) return false;
  if (row.is_active !== true) return false;
  if (row.suspended_at !== null && row.suspended_at !== undefined) return false;
  const status = row.status;
  if (status !== null && status !== undefined && status.toLowerCase() !== ACTIVE_USER_STATUS) return false;
  return true;
}
