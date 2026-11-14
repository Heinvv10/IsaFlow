// src/lib/auth/loginAsRecord.ts
// Ending a Login-as, on every path (admin audit 2026-11-14, 3.10): the end is recorded FIRST (an
// `impersonation_end` row, committed: the app pool's autocommit), then the session is revoked at GoTrue
// when this request holds its token, then the admin's stash rows go and expired ones are purged, and only
// then may the caller set cookies. The revocation's outcome (and how many stashes went) is added to that
// same row afterwards (`noteLoginAsEnd`), so the row says `target_session_revoked: null` (unknown) until
// then, and stays honest if that last write fails.
import { isSessionAlreadyGone, logout, verifyTokenSignature } from './gotrue';
import { impersonationPartiesOf } from './impersonationSessions';
import { sql, withTransaction } from '@/lib/neon';
import { log } from '@/lib/logger';
import { deleteEndedStashes, purgeExpiredStashes } from '@/modules/admin/services/userImpersonationService';

export interface LoginAsParties { actorUserId: string; targetUserId: string }
/** A recorded Login-as session: its parties and its verified GoTrue `session_id`. */
export interface LoginAsSession extends LoginAsParties { sessionId: string }

/**
 * What names one Login-as for its end row, SERVER-VERIFIED by the caller: `sessionId` from a verified token whose
 * session record gave these parties; `stashId` from a stash row loaded for these parties. Never a raw cookie.
 */
export interface LoginAsEndKey { sessionId?: string; stashId?: string }

const noteFailure = (reason: string, step: string, err: unknown) =>
  log.error(`end of Login-as (${reason}): ${step} failed`, { message: err instanceof Error ? err.message : String(err) }, 'Auth');

/**
 * The recorded Login-as session `accessToken` belongs to (its verified `session_id`), or null for an ordinary
 * session or a token whose signature does not verify (expired, or not ours: it names no session, so there is
 * nothing to close; not a failure). A lookup failure throws. Sign Out reads it bounded and capped (logout.ts).
 */
export async function loginAsPartiesOfToken(accessToken: string): Promise<LoginAsSession | null> {
  let sessionId: unknown;
  try {
    sessionId = (await verifyTokenSignature(accessToken)).session_id;
  } catch {
    return null;
  }
  if (typeof sessionId !== 'string') return null;
  const parties = await impersonationPartiesOf(sessionId);
  return parties ? { ...parties, sessionId } : null;
}

/**
 * Writes the `impersonation_end` row and returns its id. Throws when it cannot: the caller must stop there.
 * One row per Login-as (#1371 re-break B3b): when an end row for these parties already carries the same verified
 * key (a retry after a lost answer or a later failure), that row is returned instead. With a session id the match
 * is on `session_id` ONLY (re-break M4: a stash cookie swapped between two Login-as of one pair must not fold one
 * session's end into the other's row); the stash id matches only an end with no session (the admin's own browser),
 * unchanged; the caller's outcome then lands on it through `noteLoginAsEnd`. Only server-verified keys match
 * (LoginAsEndKey), so a forged stash cookie cannot reach an earlier session's row. The look-up and the insert run
 * in one transaction under a transaction-scoped advisory lock per key (`login-as-end:<key>`, taken in sorted order),
 * so two ends of one Login-as racing each other write one row.
 */
export async function recordLoginAsEnd(
  parties: LoginAsParties, key: LoginAsEndKey, details: Record<string, unknown>,
): Promise<string> {
  const lockKeys = [key.sessionId && `session:${key.sessionId}`, key.stashId && `stash:${key.stashId}`]
    .filter((k): k is string => Boolean(k)).sort();
  return withTransaction(async (tx) => {
    for (const k of lockKeys) await tx`SELECT pg_advisory_xact_lock(hashtextextended(${`login-as-end:${k}`}, 0))`;
    if (lockKeys.length > 0) {
      const [existing] = await tx`
        SELECT id FROM admin_audit_log
        WHERE admin_user_id = ${parties.actorUserId} AND action = 'impersonation_end' AND target_id = ${parties.targetUserId}
          AND CASE WHEN ${key.sessionId ?? null}::text IS NOT NULL
                   THEN details->>'session_id' = ${key.sessionId ?? null}
                   ELSE details->>'stash_id' = ${key.stashId ?? null} END
        ORDER BY created_at LIMIT 1
      ` as { id: string }[];
      if (existing) return String(existing.id);
    }
    const [row] = await tx`
      INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
      VALUES (${parties.actorUserId}, 'impersonation_end', 'user', ${parties.targetUserId},
              ${JSON.stringify({
                target_session_revoked: null, ...details,
                ...(key.sessionId ? { session_id: key.sessionId } : {}), ...(key.stashId ? { stash_id: key.stashId } : {}),
              })}::jsonb)
      RETURNING id
    ` as { id: string }[];
    return String(row!.id);
  });
}

/** Adds what happened after the end was recorded to that row. Logged, never thrown: the row already stands. */
export async function noteLoginAsEnd(endId: string, outcome: Record<string, unknown>): Promise<void> {
  try {
    // Never from revoked to not revoked (re-break M2): a retry whose revocation found nothing left to revoke, or
    // failed, does not undo an earlier recorded revocation.
    await sql`
      UPDATE admin_audit_log
      SET details = coalesce(details, '{}'::jsonb) || ${JSON.stringify(outcome)}::jsonb
        || CASE WHEN details->>'target_session_revoked' = 'true'
                THEN '{"target_session_revoked": true}'::jsonb ELSE '{}'::jsonb END
      WHERE id = ${endId}::uuid AND action = 'impersonation_end'
    `;
  } catch (err) { noteFailure('outcome', 'recording the outcome', err); }
}

/**
 * Revokes the session `accessToken` names at GoTrue (scope=local: that session only). False when it could not;
 * true also when GoTrue answers that the session no longer exists (session_not_found: already revoked).
 */
export async function revokeLoginAsSession(accessToken: string, reason: string): Promise<boolean> {
  try {
    await logout(accessToken, 'local');
    return true;
  } catch (err) {
    if (isSessionAlreadyGone(err)) return true;
    noteFailure(reason, 'GoTrue revocation', err);
    return false;
  }
}

/**
 * Removes every expired admin stash. Opportunistic (the start and end paths call it; there is no timer) and never
 * in the way: a failure is logged and the caller carries on.
 */
export async function purgeExpiredStashesBestEffort(source: string): Promise<void> {
  try {
    const purged = await purgeExpiredStashes();
    if (purged > 0) log.info('expired admin stashes purged', { source, purged }, 'Auth');
  } catch (err) {
    noteFailure(source, 'expired stash purge', err);
  }
}

/**
 * The stash `stashId` names if it is these parties' (the cookie is only a browser's say-so, so it names a row,
 * never whose), and any of theirs already expired; then every expired stash. Returns how many of theirs went,
 * or null when that delete failed (logged).
 */
export async function removeLoginAsStashes(parties: LoginAsParties, stashId: string | undefined, reason: string): Promise<number | null> {
  let removed: number | null = null;
  try {
    removed = await deleteEndedStashes({ adminUserId: parties.actorUserId, targetUserId: parties.targetUserId, stashId });
  } catch (err) { noteFailure(reason, 'stash removal', err); }
  await purgeExpiredStashesBestEffort(reason);
  return removed;
}

/**
 * A Login-as ending without "Return to my session" (Sign Out, an expired proof at refresh): record, revoke,
 * remove, note. Never throws, and the end is never refused for a failed audit write (logged): signing out must
 * always work. `revoke` is the caller's own GoTrue step and reports whether it landed.
 */
export async function endLoginAsWithoutRestore(input: {
  parties: LoginAsSession; stashId: string | undefined; reason: string; revoke: () => Promise<boolean>;
}): Promise<void> {
  let endId: string | null = null;
  try {
    // Keyed on the verified session only: the stash cookie is a browser's say-so (it still names the row to remove).
    endId = await recordLoginAsEnd(input.parties, { sessionId: input.parties.sessionId }, { reason: input.reason });
  } catch (err) { noteFailure(input.reason, 'audit', err); }
  const revoked = await input.revoke();
  const stashesRemoved = await removeLoginAsStashes(input.parties, input.stashId, input.reason);
  if (endId) await noteLoginAsEnd(endId, { target_session_revoked: revoked, stashes_removed: stashesRemoved });
}
