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
  // Migration 677 owns both reads, so the request path needs no grant on the stash table.
  // This runs on the DATABASE_URL login role from verifyToken, before any app_user
  // transaction; if the call fails, impersonationActor logs it and refuses the proof.
  const rows = await sql<{ live: boolean }>`
    SELECT public.impersonation_delegation_live(${stashId}::uuid, ${actorUserId}, ${targetUserId},
      ${targetSessionId}) AS live
  `;
  return rows[0]?.live === true;
}
