import { sql } from '@/lib/neon';

/**
 * A delegation proof is a claim about a live arrangement, not a bearer right of
 * its own. It is signature-checked and hour-bounded, which means a copied pair
 * of cookies would otherwise keep authenticating as the member for the rest of
 * that hour AFTER the administrator ended the impersonation. The arrangement's
 * durable side is the stash row (deleted when impersonation ends) and the
 * impersonation_end audit entry for the minted session; the proof is honoured
 * only while the first is present and the second is absent.
 */
export async function impersonationDelegationLive(stashId: string, actorUserId: string,
  targetUserId: string, targetSessionId: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(stashId)) return false;
  const rows = await sql<{ live: boolean; ended: boolean }>`
    SELECT
      EXISTS(SELECT 1 FROM admin_impersonation_stash
        WHERE stash_id = ${stashId}::uuid AND admin_user_id = ${actorUserId}
          AND target_user_id = ${targetUserId} AND expires_at > NOW()) AS live,
      EXISTS(SELECT 1 FROM admin_audit_log
        WHERE action IN ('impersonation_end','impersonation_end_failed') AND target_type = 'user'
          AND target_id::text = ${targetUserId}
          AND details->>'target_session_id' = ${targetSessionId}) AS ended
  `;
  const row = rows[0];
  return row?.live === true && row.ended !== true;
}
