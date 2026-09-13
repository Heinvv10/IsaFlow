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
interface ReaderState {
  reader: boolean; liveness: boolean; reader_exec: boolean | null; liveness_exec: boolean | null;
  reader_sees: boolean | null; liveness_sees: boolean | null;
  login_role?: string;
}
/** Both halves of "this function can see the evidence": SECURITY DEFINER, and an owner that bypasses RLS. */
const sees = (fn: string) => `(SELECT p.prosecdef AND COALESCE(r.rolbypassrls, false)
    FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner WHERE p.oid = to_regprocedure('${fn}'))`;
/**
 * Existence of both functions, EXECUTE for the role that really calls each, and the ability
 * of each to see past the RLS migration 691 put on the evidence tables, in one statement. The
 * reader runs inside withAuth after SET LOCAL ROLE app_user. The liveness check runs earlier,
 * from verifyToken, on the DATABASE_URL login role through the pool - no app_user transaction
 * exists yet - so it is checked for current_user, and the gate must run with the same
 * DATABASE_URL as the application (deploy.sh does).
 */
export const IMPERSONATION_READER_GATE_SQL = `SELECT
  to_regprocedure('${READER}') IS NOT NULL AS reader,
  to_regprocedure('${LIVENESS}') IS NOT NULL AS liveness,
  has_function_privilege('app_user', to_regprocedure('${READER}'), 'EXECUTE') AS reader_exec,
  has_function_privilege(current_user, to_regprocedure('${LIVENESS}'), 'EXECUTE') AS liveness_exec,
  ${sees(READER)} AS reader_sees,
  ${sees(LIVENESS)} AS liveness_sees,
  current_user::text AS login_role`;

/**
 * Deploy gate. The two failure modes differ and both must stop the deploy:
 * - the reader missing, or app_user unable to execute it: resolveImpersonatingActor's query
 *   throws inside withAuth, so every authenticated request 500s (or, when merely missing,
 *   every review is refused as unverified);
 * - the liveness function missing or not executable by the login role: every delegation
 *   proof is silently refused - impersonationActor logs the error and returns null - so the
 *   MFA bypass for impersonated sessions switches off. Fail closed, but not a working state;
 * - either function unable to see past the RLS migration 691 put on the evidence tables (it
 *   lost SECURITY DEFINER, or its owner lost BYPASSRLS): the reader then reports every session
 *   as unverified and no review can be recorded, and liveness refuses every proof. Both fail
 *   closed by design, and both are states the deploy must refuse rather than serve.
 */
export async function assertImpersonationReaderDeployed(
  query: (text: string) => Promise<ReaderState[]>): Promise<void> {
  const row = (await query(IMPERSONATION_READER_GATE_SQL))[0];
  if (row?.reader !== true) throw new Error(`${READER} is not deployed: apply migration 675 before serving requests`);
  if (row.liveness !== true) throw new Error(`${LIVENESS} is not deployed: apply migration 677 before serving requests`);
  if (row.reader_exec !== true) throw new Error(`app_user cannot EXECUTE ${READER}`);
  if (row.liveness_exec !== true) {
    throw new Error(`${row.login_role ?? 'the DATABASE_URL role'} cannot EXECUTE ${LIVENESS}`);
  }
  if (row.reader_sees !== true) {
    throw new Error(`${READER} cannot read the impersonation evidence: it must be SECURITY DEFINER and owned by a BYPASSRLS role (migration 691)`);
  }
  if (row.liveness_sees !== true) {
    throw new Error(`${LIVENESS} cannot read the impersonation evidence: it must be SECURITY DEFINER and owned by a BYPASSRLS role (migration 691)`);
  }
}

/** The exact line the gate prints on success; scripts/deploy.sh requires it verbatim. */
export const IMPERSONATION_READER_GATE_SUCCESS = 'impersonation readers present and executable by their calling roles';

/** The deploy gate's whole job, separable from the process so it can be tested. */
export async function runImpersonationReaderGate(
  query: (text: string) => Promise<ReaderState[]>, out: (line: string) => void): Promise<void> {
  await assertImpersonationReaderDeployed(query);
  out(`${IMPERSONATION_READER_GATE_SUCCESS}\n`);
}
