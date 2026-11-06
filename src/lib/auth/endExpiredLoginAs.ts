// src/lib/auth/endExpiredLoginAs.ts
import type { NextApiResponse } from 'next';
import { logout, verifyTokenSignature } from './gotrue';
import { clearAuthCookies } from './cookies';
import { clearImpersonationCookies } from './impersonation-cookies';
import { impersonationPartiesOf } from './impersonationSessions';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { deleteStash } from '@/modules/admin/services/userImpersonationService';

const noteFailure = (step: string, err: unknown) =>
  log.error(`end of expired Login-as: ${step} failed`, { message: err instanceof Error ? err.message : String(err) }, 'Auth');

/**
 * A Login-as session whose proof has run out, refused at /api/auth/refresh. Ends it
 * as end-impersonation would, minus restoring the admin: revoked at GoTrue so a copy
 * of the refresh token cannot keep it going, the admin's stashed tokens removed, and
 * the end recorded. The refusal stands whichever of those fail, so the cookies always clear.
 */
export async function endExpiredLoginAs(res: NextApiResponse, accessToken: string, stashId?: string): Promise<void> {
  try { await logout(accessToken, 'local'); }
  catch (err) { noteFailure('revocation', err); }

  if (stashId) {
    try { await deleteStash(stashId); }
    catch (err) { noteFailure('stash removal', err); }
  }

  try {
    const { session_id: sessionId } = await verifyTokenSignature(accessToken);
    const parties = typeof sessionId === 'string' ? await impersonationPartiesOf(sessionId) : null;
    if (parties) {
      await sql`
        INSERT INTO admin_audit_log (admin_user_id, action, target_type, target_id, details)
        VALUES (
          ${parties.actorUserId},
          'impersonation_end',
          'user',
          ${parties.targetUserId},
          ${JSON.stringify({ reason: 'proof_expired', stash_id: stashId ?? null })}::jsonb
        )
      `;
    }
  } catch (err) { noteFailure('audit', err); }

  clearAuthCookies(res);
  clearImpersonationCookies(res);
}
