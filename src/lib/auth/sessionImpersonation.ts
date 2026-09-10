import type { PoolClient } from 'pg';
import { impersonationActor } from './impersonationAssurance';
import { IMPERSONATION_UNVERIFIED } from './impersonationState';
import { log } from '@/lib/logger';
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
    // Without the reader nothing can be established, and an administrator who drops the
    // proof cookie against a member with no verified factor would otherwise be recorded as
    // that member with no actor at all. So the request path fails closed for every session;
    // assertImpersonationReaderDeployed is what keeps this state off a live database, by
    // failing the deploy instead of the requests.
    if (probe.rows[0]?.available !== true) {
      log.error('control_session_impersonator() is not deployed; impersonation state is unverifiable',
        {}, 'Auth');
      return IMPERSONATION_UNVERIFIED;
    }
    readerPresent = true;
  }
  const recorded = await client.query<{ actor: string | null }>(`SELECT ${READER} AS actor`);
  return recorded.rows[0]?.actor ?? null;
}

const LIVENESS = 'public.impersonation_delegation_live(uuid,text,text,text)';
interface ReaderState { reader: boolean; liveness: boolean; reader_exec: boolean | null; liveness_exec: boolean | null }
/** Existence of both functions and app_user's EXECUTE on each, in one statement. */
export const IMPERSONATION_READER_GATE_SQL = `SELECT
  to_regprocedure('${READER}') IS NOT NULL AS reader,
  to_regprocedure('${LIVENESS}') IS NOT NULL AS liveness,
  has_function_privilege('app_user', to_regprocedure('${READER}'), 'EXECUTE') AS reader_exec,
  has_function_privilege('app_user', to_regprocedure('${LIVENESS}'), 'EXECUTE') AS liveness_exec`;

/**
 * Deploy gate. Without the reader every approval is refused at runtime (the request path
 * fails closed); without EXECUTE for app_user on either function every authenticated
 * request 500s. Both must fail the deploy instead.
 */
export async function assertImpersonationReaderDeployed(
  query: (text: string) => Promise<ReaderState[]>): Promise<void> {
  const row = (await query(IMPERSONATION_READER_GATE_SQL))[0];
  if (row?.reader !== true) throw new Error(`${READER} is not deployed: apply migration 675 before serving requests`);
  if (row.liveness !== true) throw new Error(`${LIVENESS} is not deployed: apply migration 677 before serving requests`);
  if (row.reader_exec !== true) throw new Error(`app_user cannot EXECUTE ${READER}`);
  if (row.liveness_exec !== true) throw new Error(`app_user cannot EXECUTE ${LIVENESS}`);
}
