// src/lib/auth/loginAsRecord.ts
// Ending a Login-as, on every path (admin audit 2026-11-14, 3.10): the end is recorded FIRST (an
// `impersonation_end` row, committed: the app pool's autocommit), then the session is revoked at GoTrue
// when this request holds its token, then the admin's stash rows go and expired ones are purged, and only
// then may the caller set cookies. The revocation's outcome (and how many stashes went) is added to that
// same row afterwards (`noteLoginAsEnd`), so the row says `target_session_revoked: null` (unknown) until
// then, and stays honest if that last write fails.
import { logout, verifyTokenSignature } from './gotrue';
import { impersonationPartiesOf } from './impersonationSessions';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { deleteEndedStashes, purgeExpiredStashes } from '@/modules/admin/services/userImpersonationService';

export interface LoginAsParties { actorUserId: string; targetUserId: string }

const noteFailure = (reason: string, step: string, err: unknown) =>
  log.error(`end of Login-as (${reason}): ${step} failed`, { message: err instanceof Error ? err.message : String(err) }, 'Auth');

/**
 * The parties of the recorded Login-as session `accessToken` belongs to (its verified `session_id`), or null
 * for an ordinary session or a token whose signature does not verify. A lookup failure throws.
 */
export async function loginAsPartiesOfToken(accessToken: string): Promise<LoginAsParties | null> {
  let sessionId: unknown;
  try {
    sessionId = (await verifyTokenSignature(accessToken)).session_id;
  } catch {
    return null; // not a token this app signed (or expired): it names no session
  }
  return typeof sessionId === 'string' ? impersonationPartiesOf(sessionId) : null;
}

/** Writes the `impersonation_end` row and returns its id. Throws when it cannot: the caller must stop there. */
export async function recordLoginAsEnd(parties: LoginAsParties, details: Record<string, unknown>): Promise<string> {
  const rows = await sql<{ id: string }>`
    INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
    VALUES (${parties.actorUserId}, 'impersonation_end', 'user', ${parties.targetUserId},
            ${JSON.stringify({ target_session_revoked: null, ...details })}::jsonb)
    RETURNING id
  `;
  return String(rows[0]!.id);
}

/** Adds what happened after the end was recorded to that row. Logged, never thrown: the row already stands. */
export async function noteLoginAsEnd(endId: string, outcome: Record<string, unknown>): Promise<void> {
  try {
    await sql`
      UPDATE admin_audit_log SET details = coalesce(details, '{}'::jsonb) || ${JSON.stringify(outcome)}::jsonb
      WHERE id = ${endId}::uuid AND action = 'impersonation_end'
    `;
  } catch (err) { noteFailure('outcome', 'recording the outcome', err); }
}

/** Revokes the session `accessToken` names at GoTrue (scope=local: that session only). False when it could not. */
export async function revokeLoginAsSession(accessToken: string, reason: string): Promise<boolean> {
  try {
    await logout(accessToken, 'local');
    return true;
  } catch (err) {
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
  parties: LoginAsParties; stashId: string | undefined; reason: string; revoke: () => Promise<boolean>;
}): Promise<void> {
  let endId: string | null = null;
  try {
    endId = await recordLoginAsEnd(input.parties, { reason: input.reason });
  } catch (err) { noteFailure(input.reason, 'audit', err); }
  const revoked = await input.revoke();
  const stashesRemoved = await removeLoginAsStashes(input.parties, input.stashId, input.reason);
  if (endId) await noteLoginAsEnd(endId, { target_session_revoked: revoked, stashes_removed: stashesRemoved });
}
