// src/lib/auth/loginAsRecord.ts
// The server-side remains of a Login-as that ended without "Return to my session" (admin audit 2026-11-14, 3.10).
import { verifyTokenSignature } from './gotrue';
import { impersonationPartiesOf } from './impersonationSessions';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { deleteEndedStashes, purgeExpiredStashes } from '@/modules/admin/services/userImpersonationService';

const noteFailure = (reason: string, step: string, err: unknown) =>
  log.error(`end of Login-as (${reason}): ${step} failed`, { message: err instanceof Error ? err.message : String(err) }, 'Auth');

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
 * When `accessToken` belongs to a recorded Login-as session: removes the admin's stashed tokens by the parties on
 * the session record (the stash cookie is only a browser's say-so, so it names a row, never whose), and records
 * the end. Does nothing for an ordinary session. Never throws: the caller is ending a session and must clear its
 * cookies whatever happens here. Revoking the session at GoTrue is the caller's step.
 */
export async function closeLoginAsRecord(accessToken: string, stashId: string | undefined, reason: string): Promise<void> {
  try {
    const { session_id: sessionId } = await verifyTokenSignature(accessToken);
    const parties = typeof sessionId === 'string' ? await impersonationPartiesOf(sessionId) : null;
    if (!parties) return;
    let stashesRemoved: number | null = null;
    try {
      stashesRemoved = await deleteEndedStashes({ adminUserId: parties.actorUserId, targetUserId: parties.targetUserId, stashId });
    } catch (err) { noteFailure(reason, 'stash removal', err); }
    await sql`
      INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
      VALUES (
        ${parties.actorUserId},
        'impersonation_end',
        'user',
        ${parties.targetUserId},
        ${JSON.stringify({ reason, stashes_removed: stashesRemoved })}::jsonb
      )
    `;
  } catch (err) { noteFailure(reason, 'audit', err); }
  await purgeExpiredStashesBestEffort(reason);
}
