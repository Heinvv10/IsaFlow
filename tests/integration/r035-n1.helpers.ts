/**
 * R-035 N1 fixture: run raw SQL as a database role (app_user, platform_admin)
 * under a request's claims, call the SECURITY DEFINER writers directly, and
 * plant a supplier-invoice company with a pending request raised through the
 * real route — so a forgery is attempted against a row the app wrote.
 */
import type { Pool, PoolClient } from 'pg';
import { createUser, plantBill, plantRule } from './r035-approval.helpers';
import { dataOf, enforce, postableCompany, routes } from './r035-pr2.helpers';

type Tokens = Record<string, string>;

export interface Claims { sub?: string; sessionId?: string | null }

/**
 * `fn` as `role` inside one transaction carrying withAuth's GUCs, rolled back
 * unless `commit`. A session id is minted unless `sessionId: null` (a request
 * whose session cannot be classified).
 */
export async function asRole<T>(pool: Pool, role: 'app_user' | 'platform_admin', companyId: string, claims: Claims,
  fn: (client: PoolClient) => Promise<T>, commit = false): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    const jwt: Record<string, string> = { role: 'authenticated' };
    if (claims.sub !== undefined) jwt.sub = claims.sub;
    if (claims.sessionId !== null) jwt.session_id = claims.sessionId ?? crypto.randomUUID();
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify(jwt)]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [companyId]);
    const result = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** The SQLSTATE `p` rejects with, or 'ok'. */
export async function outcome(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'ok';
  } catch (error) {
    return String((error as { code?: unknown }).code ?? (error as Error).message);
  }
}

export const decideFn = (cl: PoolClient, company: string, requestId: string, decision: string, by: string,
  expected: string | null) => cl.query(
  'SELECT * FROM approval_request_decide($1, $2, $3, $4, $5, $6)', [company, requestId, decision, by, null, expected]);

export const raiseFn = (cl: PoolClient, company: string, type: string, documentId: string, ruleId: string, by: string) =>
  cl.query('SELECT * FROM approval_request_raise($1, $2, $3, $4, $5)', [company, type, documentId, ruleId, by]);

export const rebindFn = (cl: PoolClient, company: string, requestId: string, ruleId: string | null, by: string) =>
  cl.query('SELECT * FROM approval_request_rebind($1, $2, $3, $4)', [company, requestId, ruleId, by]);

export const requestRow = async (pool: Pool, id: string) => (await pool.query(
  'SELECT status, required_role, rule_id, decided_by, requested_by, document_digest FROM approval_requests WHERE id = $1',
  [id])).rows[0] as Record<string, string | null> | undefined;

/** Users a (owner), b (owner), m (manager), v (viewer), with tokens. */
export async function n1Users(pool: Pool, tokens: Tokens) {
  return { a: await createUser(pool, tokens), b: await createUser(pool, tokens),
    m: await createUser(pool, tokens), v: await createUser(pool, tokens) };
}

/**
 * A postable supplier-invoice company — a, b owners; m manager; v viewer —
 * enforcement on, an `owner any` rule and a manager rule beside it, a bill
 * created by a, and a pending request for it raised by b through the route
 * (each overridable).
 */
export async function pendingBill(pool: Pool, tokens: Tokens, u: { a: string; b: string; m: string; v: string },
  companies: string[], opts: { creator?: string; requester?: string; members?: [string, string][] } = {}) {
  const c = await postableCompany(pool,
    opts.members ?? [[u.a, 'owner'], [u.b, 'owner'], [u.m, 'manager'], [u.v, 'viewer']], companies);
  const ownerRule = await plantRule(pool, c, 'owner', { name: 'n1 owner' });
  const managerRule = await plantRule(pool, c, 'manager', { name: 'n1 manager' });
  await enforce(pool, c, u.a);
  const bill = await plantBill(pool, c, opts.creator ?? u.a);
  const raised = await routes(tokens).raise(opts.requester ?? u.b, c, bill.id);
  if (raised.state.statusCode !== 200) throw new Error(`raise: ${JSON.stringify(raised.state.body)}`);
  return { c, bill, ownerRule, managerRule, requestId: dataOf<{ id: string }>(raised).id };
}
