/**
 * Fixture for the intercompany (999p) suites: real PostgreSQL, synthetic rows only, sessions opened exactly as
 * withAuth opens one (app_user, the member's claims, the active company) and the real routes called with real
 * signed tokens.
 *
 *   A, B   current members of group G           C   in another group (H), never with A or B
 *   uab    owner of A and B     ua  owner of A     ub  owner of B     uc  owner of C
 *   uac    owner of A and C     uva viewer of A
 */
import type { Pool, PoolClient } from 'pg';
import connectionsRoute from '../../../pages/api/accounting/intercompany/connections';
import connectionRoute from '../../../pages/api/accounting/intercompany/connections/[id]';
import candidatesRoute from '../../../pages/api/accounting/intercompany/group-candidates';
import { callRoute, createUser } from '../r035-approval.helpers';

export const U = { ab: '', a: '', b: '', c: '', ac: '', va: '' };
export const tokens: Record<string, string> = {};
export const co = { A: '', B: '', C: '', G: '', H: '' };
export const acct = { aLoan: '', aExpense: '', aHeader: '', aChild: '', aInactive: '', bLoan: '' };
export const party = { aCustomer: '', aSupplier: '', bCustomer: '', bSupplier: '' };

const companies: string[] = [];

export async function setup(pool: Pool): Promise<void> {
  for (const k of Object.keys(U) as (keyof typeof U)[]) U[k] = await createUser(pool, tokens);
  const mk = async (name: string, members: [string, string][]) => {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [id, `IC ${name} ${id.slice(0, 6)}`]);
    for (const [user, role] of members) {
      await pool.query('INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, $3)', [id, user, role]);
    }
    companies.push(id);
    return id;
  };
  co.A = await mk('A', [[U.ab, 'owner'], [U.a, 'owner'], [U.ac, 'owner'], [U.va, 'viewer']]);
  co.B = await mk('B', [[U.ab, 'owner'], [U.b, 'owner']]);
  co.C = await mk('C', [[U.c, 'owner'], [U.ac, 'owner']]);
  co.G = crypto.randomUUID();
  co.H = crypto.randomUUID();
  await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC group G'), ($2, 'IC group H')", [co.G, co.H]);
  await pool.query(
    'INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3), ($4, $5)',
    [co.G, co.A, co.B, co.H, co.C]);

  const ids = Object.keys(acct) as (keyof typeof acct)[];
  for (const k of ids) acct[k] = crypto.randomUUID();
  const account = (id: string, company: string, code: string, parent: string | null, active = true) => pool.query(
    `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, parent_account_id, is_active)
     VALUES ($1, $2, $3, $3, 'liability', 'credit', $4, $5)`, [id, company, code, parent, active]);
  const tag = co.A.slice(0, 5);
  await account(acct.aHeader, co.A, `ICH${tag}`, null);
  await account(acct.aChild, co.A, `ICC${tag}`, acct.aHeader);
  await account(acct.aLoan, co.A, `ICL${tag}`, null);
  await account(acct.aExpense, co.A, `ICE${tag}`, null);
  await account(acct.aInactive, co.A, `ICI${tag}`, null, false);
  await account(acct.bLoan, co.B, `ICL${co.B.slice(0, 5)}`, null);
  for (const k of Object.keys(party) as (keyof typeof party)[]) party[k] = crypto.randomUUID();
  await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
    [party.aCustomer, co.A, 'IC A customer', party.bCustomer, co.B, 'IC B customer']);
  await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3), ($4, $5, $6)',
    [party.aSupplier, co.A, 'IC A supplier', party.bSupplier, co.B, 'IC B supplier']);
}

export async function cleanup(pool: Pool): Promise<void> {
  const users = Object.values(U);
  const del = async (text: string, params: unknown[]) => {
    try { await pool.query(text, params); } catch (err) { process.stderr.write(`cleanup: ${text}: ${String(err)}\n`); }
  };
  await del('DELETE FROM intercompany_document_links WHERE company_a_id = ANY($1) OR company_b_id = ANY($1)', [companies]);
  await del('DELETE FROM intercompany_messages WHERE from_company_id = ANY($1) OR to_company_id = ANY($1)', [companies]);
  await del('DELETE FROM intercompany_connection_sides WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM intercompany_connections WHERE company_low_id = ANY($1) OR company_high_id = ANY($1)', [companies]);
  await del('DELETE FROM company_connection_keys WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await del('UPDATE gl_accounts SET parent_account_id = NULL WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM customers WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM suppliers WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM company_group_members WHERE group_id = ANY($1)', [[co.G, co.H]]);
  await del('DELETE FROM company_groups WHERE id = ANY($1)', [[co.G, co.H]]);
  await del('DELETE FROM company_users WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM companies WHERE id = ANY($1)', [companies]);
  await del('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await pool.end();
}

/** Every row of the five tables for these companies, so a test starts clean. */
export async function wipeConnections(pool: Pool): Promise<void> {
  const where: Record<string, string> = {
    intercompany_document_links: 'company_a_id = ANY($1) OR company_b_id = ANY($1)',
    intercompany_messages: 'from_company_id = ANY($1) OR to_company_id = ANY($1)',
    intercompany_connection_sides: 'company_id = ANY($1)',
    intercompany_connections: 'company_low_id = ANY($1) OR company_high_id = ANY($1)',
    company_connection_keys: 'company_id = ANY($1)',
  };
  for (const [table, predicate] of Object.entries(where)) await pool.query(`DELETE FROM ${table} WHERE ${predicate}`, [companies]);
}

/** A session as withAuth opens one. Rolled back unless `commit`. */
export async function asAppUser<T>(pool: Pool, user: string, company: string, fn: (q: PoolClient) => Promise<T>, commit = false): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
    const out = await fn(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** 'ok', or `<SQLSTATE>: <message>` of the refusal. Runs in a savepoint so the session stays usable. */
export async function outcome(q: PoolClient, text: string, params: unknown[] = []): Promise<string> {
  await q.query('SAVEPOINT ic_probe');
  try {
    await q.query(text, params);
    await q.query('RELEASE SAVEPOINT ic_probe');
    return 'ok';
  } catch (err) {
    await q.query('ROLLBACK TO SAVEPOINT ic_probe');
    const e = err as { code?: string; message?: string };
    return `${e.code}: ${e.message}`;
  }
}

export const count = async (q: Pool | PoolClient, text: string, params: unknown[] = []): Promise<number> =>
  Number((await q.query(text, params)).rows[0].n);

/** The pair in the table's order. */
export const pairOf = (x: string, y: string) => (x.toLowerCase() < y.toLowerCase() ? [x, y] : [y, x]) as [string, string];

const url = '/api/accounting/intercompany/connections';
export const api = {
  list: (user: string, company: string) => callRoute(connectionsRoute, tokens[user]!, company, 'GET', undefined, url),
  create: (user: string, company: string, body: unknown) => callRoute(connectionsRoute, tokens[user]!, company, 'POST', body, url),
  edit: (user: string, company: string, id: string, body: unknown) =>
    callRoute(connectionRoute, tokens[user]!, company, 'PUT', body, `${url}/${id}`, { id }),
  revoke: (user: string, company: string, id: string) =>
    callRoute(connectionRoute, tokens[user]!, company, 'DELETE', undefined, `${url}/${id}`, { id }),
  candidates: (user: string, company: string) =>
    callRoute(candidatesRoute, tokens[user]!, company, 'GET', undefined, '/api/accounting/intercompany/group-candidates'),
};

/**
 * A connection as superuser plants it (bypasses RLS; the guard triggers still run, with the claims of `by` and
 * the inviting company as the session). An 'active' external one is accepted by the other company, as 999p requires.
 */
export async function plantConnection(pool: Pool, kind: 'group' | 'external', x: string, y: string, opts: { status?: 'pending' | 'active'; by?: string } = {}): Promise<string> {
  const [low, high] = pairOf(x, y);
  const by = opts.by ?? U.ab;
  const status = opts.status ?? (kind === 'group' ? 'active' : 'pending');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: by })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [low]);
    const r = await client.query(
      `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id)
       VALUES ($1, $2, $3, $4, $1) RETURNING id`, [low, high, kind, kind === 'group' ? 'active' : 'pending']);
    const id = r.rows[0].id as string;
    if (kind === 'external' && status === 'active') {
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [high]);
      await client.query("UPDATE intercompany_connections SET status = 'active' WHERE id = $1", [id]);
    }
    await client.query('COMMIT');
    return id;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
