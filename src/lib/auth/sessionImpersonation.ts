import type { PoolClient } from 'pg';
import { impersonationActor } from './impersonationAssurance';
import { IMPERSONATION_UNVERIFIED } from '@/modules/accounting/services/controls/independentReview';
import type { GoTrueClaims } from './gotrue';

const READER = 'public.control_session_impersonator()';
let readerPresent = false;

/** Tests only: the presence cache is process-wide and one-way, like a deployed function. */
export function resetImpersonationReaderCache(): void { readerPresent = false; }

/**
 * Who is actually driving this cookie session. The delegation proof names the
 * actor directly, but a platform admin can simply drop that cookie when the
 * impersonated member has no verified MFA factor, so the recorded impersonation
 * session is consulted too: it survives the cookie, a refresh and the stash.
 *
 * When migration 675 has not been applied the reader function does not exist.
 * Calling it unconditionally would 500 every authenticated request on a database
 * that lags migrations (this repo has had one), so absence is detected and
 * reported as IMPERSONATION_UNVERIFIED instead: ordinary requests continue, and
 * only the places that record a human review fail closed.
 */
export async function resolveImpersonatingActor(client: PoolClient, claims: GoTrueClaims,
  proof: string | undefined): Promise<string | null> {
  const delegated = proof ? await impersonationActor(proof, claims) : null;
  if (delegated) return delegated;
  if (!readerPresent) {
    const probe = await client.query<{ available: boolean }>(
      `SELECT to_regprocedure('${READER}') IS NOT NULL AS available`);
    if (probe.rows[0]?.available !== true) return IMPERSONATION_UNVERIFIED;
    readerPresent = true;
  }
  const recorded = await client.query<{ actor: string | null }>(`SELECT ${READER} AS actor`);
  return recorded.rows[0]?.actor ?? null;
}
