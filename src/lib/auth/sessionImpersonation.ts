import type { PoolClient } from 'pg';
import { impersonationActor } from './impersonationAssurance';
import type { GoTrueClaims } from './gotrue';

/**
 * Who is actually driving this cookie session. The delegation proof names the
 * actor directly, but a platform admin can simply drop that cookie when the
 * impersonated member has no verified MFA factor, so the recorded impersonation
 * session is consulted too: it survives the cookie, a refresh and the stash.
 * Runs on the request transaction, after the verified claims are installed.
 */
export async function resolveImpersonatingActor(client: PoolClient, claims: GoTrueClaims,
  proof: string | undefined): Promise<string | null> {
  const delegated = proof ? await impersonationActor(proof, claims) : null;
  if (delegated) return delegated;
  const recorded = await client.query<{ actor: string | null }>('SELECT public.control_session_impersonator() AS actor');
  return recorded.rows[0]?.actor ?? null;
}
