/**
 * Fixture for the intercompany (999p) suites: real PostgreSQL, synthetic rows only, sessions opened exactly as
 * withAuth opens one (app_user, the member's claims, the active company) and the real routes called with real
 * signed tokens.
 *
 *   A, B   current members of group G           C   in another group (H), never with A or B
 *   ab owner of A and B     a owner of A     b owner of B     c owner of C     ac owner of A and C
 *   va viewer of A          avb owner of A, viewer of B       mab manager of A and B       x a member of nothing
 */
import type { Pool, PoolClient } from 'pg';
import connectionsRoute from '../../../pages/api/accounting/intercompany/connections';
import connectionRoute from '../../../pages/api/accounting/intercompany/connections/[id]';
import settingsRoute from '../../../pages/api/accounting/intercompany/connections/[id]/settings';
import candidatesRoute from '../../../pages/api/accounting/intercompany/group-candidates';
import optionsRoute from '../../../pages/api/accounting/intercompany/side-options';
import { callRoute, createUser } from '../r035-approval.helpers';

export const U = { ab: '', a: '', b: '', c: '', ac: '', va: '', avb: '', mab: '', x: '' };
export const tokens: Record<string, string> = {};
export const co = { A: '', B: '', C: '', G: '', H: '' };
export const acct = { aLoan: '', aExpense: '', aHeader: '', aChild: '', aInactive: '', bLoan: '' };
export const party = { aCustomer: '', aSupplier: '', bCustomer: '', bSupplier: '' };
export const dim = { aCc1: '', bCc1: '', aCc2: '', bCc2: '', aBu: '', bBu: '' };

const companies: string[] = [];
const invoices = { cust: [] as string[], supp: [] as string[], credit: [] as string[] };

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
  co.A = await mk('A', [[U.ab, 'owner'], [U.a, 'owner'], [U.ac, 'owner'], [U.va, 'viewer'], [U.avb, 'owner'], [U.mab, 'manager']]);
  co.B = await mk('B', [[U.ab, 'owner'], [U.b, 'owner'], [U.avb, 'viewer'], [U.mab, 'manager']]);
  co.C = await mk('C', [[U.c, 'owner'], [U.ac, 'owner']]);
  co.G = crypto.randomUUID();
  co.H = crypto.randomUUID();
  await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC group G'), ($2, 'IC group H')", [co.G, co.H]);
  await pool.query(
    'INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3), ($4, $5)',
    [co.G, co.A, co.B, co.H, co.C]);

  for (const k of Object.keys(acct) as (keyof typeof acct)[]) acct[k] = crypto.randomUUID();
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
  for (const k of Object.keys(dim) as (keyof typeof dim)[]) dim[k] = crypto.randomUUID();
  await pool.query(
    `INSERT INTO cost_centres(id, company_id, code, name, cc_type) VALUES
       ($1, $5, 'IC-C1', 'A cc1', 'cc1'), ($2, $6, 'IC-C1', 'B cc1', 'cc1'), ($3, $5, 'IC-C2', 'A cc2', 'cc2'), ($4, $6, 'IC-C2', 'B cc2', 'cc2')`,
    [dim.aCc1, dim.bCc1, dim.aCc2, dim.bCc2, co.A, co.B]);
  await pool.query(`INSERT INTO business_units(id, company_id, code, name) VALUES ($1, $3, 'IC-BU', 'A bu'), ($2, $4, 'IC-BU', 'B bu')`,
    [dim.aBu, dim.bBu, co.A, co.B]);
}

export async function cleanup(pool: Pool): Promise<void> {
  const users = Object.values(U);
  const del = async (text: string, params: unknown[]) => {
    try { await pool.query(text, params); } catch (err) { process.stderr.write(`cleanup: ${text}: ${String(err)}\n`); }
  };
  await wipeConnections(pool).catch((err: unknown) => process.stderr.write(`cleanup wipe: ${String(err)}\n`));
  await del('DELETE FROM customer_invoices WHERE id = ANY($1)', [invoices.cust]);
  await del('DELETE FROM supplier_invoices WHERE id = ANY($1)', [invoices.supp]);
  await del('DELETE FROM credit_notes WHERE id = ANY($1)', [invoices.credit]);
  await del('DELETE FROM audit_log WHERE company_id = ANY($1)', [companies]);
  await del('UPDATE gl_accounts SET parent_account_id = NULL WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM gl_accounts WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM customers WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM suppliers WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM cost_centres WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM business_units WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM company_group_members WHERE group_id = ANY($1)', [[co.G, co.H]]);
  await del('DELETE FROM company_groups WHERE id = ANY($1)', [[co.G, co.H]]);
  await del('DELETE FROM company_users WHERE company_id = ANY($1)', [companies]);
  await del('DELETE FROM companies WHERE id = ANY($1)', [companies]);
  await del('DELETE FROM users WHERE id = ANY($1::text[])', [users]);
  await pool.end();
}

/** Every row of the five tables for these companies, so a test starts clean (links first: they name messages). */
export async function wipeConnections(pool: Pool): Promise<void> {
  const where: Record<string, string> = {
    intercompany_document_links: 'company_a_id = ANY($1) OR company_b_id = ANY($1)',
    intercompany_messages: 'from_company_id = ANY($1) OR to_company_id = ANY($1)',
    intercompany_connection_sides: 'company_id = ANY($1)',
    intercompany_connections: 'company_low_id = ANY($1) OR company_high_id = ANY($1)',
    company_connection_keys: 'company_id = ANY($1)',
  };
  for (const [table, predicate] of Object.entries(where)) await pool.query(`DELETE FROM ${table} WHERE ${predicate}`, [companies]);
  // A test that moved a company out of its group puts it back.
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await pool.query('INSERT INTO company_group_members(group_id, company_id) SELECT $1, c FROM unnest($2::uuid[]) c ON CONFLICT DO NOTHING', [co.G, [co.A, co.B]]);
}

async function open(pool: Pool, user: string | null, company: string, role: 'app_user' | null): Promise<PoolClient> {
  const client = await pool.connect();
  await client.query('BEGIN');
  if (role) await client.query(`SET LOCAL ROLE ${role}`);
  if (user) await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [company]);
  return client;
}

async function run<T>(client: PoolClient, fn: (q: PoolClient) => Promise<T>, commit: boolean): Promise<T> {
  try {
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

/** A session as withAuth opens one (app_user, the member's claims, the active company). Rolled back unless `commit`. */
export async function asAppUser<T>(pool: Pool, user: string, company: string, fn: (q: PoolClient) => Promise<T>, commit = false): Promise<T> {
  return run(await open(pool, user, company, 'app_user'), fn, commit);
}

/**
 * The same claims on the table OWNER's privileges (postgres, a superuser here): no column grant and no RLS stands
 * between a statement and the trigger, so a test sees the trigger's own refusal. `user` null = no session user.
 */
export async function asOwner<T>(pool: Pool, user: string | null, company: string, fn: (q: PoolClient) => Promise<T>, commit = false): Promise<T> {
  return run(await open(pool, user, company, null), fn, commit);
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
  settings: (user: string, company: string, id: string, body: unknown) =>
    callRoute(settingsRoute, tokens[user]!, company, 'PUT', body, `${url}/${id}/settings`, { id }),
  revoke: (user: string, company: string, id: string) =>
    callRoute(connectionRoute, tokens[user]!, company, 'DELETE', undefined, `${url}/${id}`, { id }),
  candidates: (user: string, company: string) =>
    callRoute(candidatesRoute, tokens[user]!, company, 'GET', undefined, '/api/accounting/intercompany/group-candidates'),
  options: (user: string, company: string) =>
    callRoute(optionsRoute, tokens[user]!, company, 'GET', undefined, '/api/accounting/intercompany/side-options'),
};

/** Run `fn` with one trigger of `table` disabled for the transaction (a superuser's DDL; it is back on at COMMIT). */
export async function withoutTrigger<T>(pool: Pool, table: string, trigger: string, fn: (q: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    const out = await fn(client);
    await client.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${trigger}`);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** A group connection as a session that may create one does (the guard triggers run). */
export async function plantConnection(pool: Pool, x: string, y: string, by = U.ab): Promise<string> {
  const [low, high] = pairOf(x, y);
  return asAppUser(pool, by, low, async (q) => (await q.query(
    `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id)
     VALUES ($1, $2, 'group', 'active', $1) RETURNING id`, [low, high])).rows[0].id as string, true);
}

/**
 * An EXTERNAL connection: the database refuses to create one until P6, so a superuser plants it with the
 * connections guard off. `active` = accepted by the high company; `revoked` = revoked by it afterwards.
 */
export async function plantExternal(pool: Pool, x: string, y: string, status: 'pending' | 'active' | 'revoked' = 'pending', by = U.ab): Promise<string> {
  const [low, high] = pairOf(x, y);
  const t = 'trg_intercompany_connections_guard';
  const id = await withoutTrigger(pool, 'intercompany_connections', t, async (q) => {
    await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: by })]);
    const r = await q.query(
      `INSERT INTO intercompany_connections(company_low_id, company_high_id, kind, status, invited_by_company_id, invited_by, accepted_by, accepted_at, revoked_by, revoked_at)
       VALUES ($1, $2, 'external', $3, $1, $4, $5, $6, $7, $6) RETURNING id`,
      [low, high, status, by, status === 'pending' ? null : by, status === 'pending' ? null : new Date(), status === 'revoked' ? by : null]);
    return r.rows[0].id as string;
  });
  return id;
}

export async function plantSide(pool: Pool, connection: string, company: string, partner: string, over: Record<string, unknown> = {}): Promise<void> {
  const cols = ['connection_id', 'company_id', 'partner_company_id', ...Object.keys(over)];
  await pool.query(`INSERT INTO intercompany_connection_sides(${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})`,
    [connection, company, partner, ...Object.values(over)]);
}

/** An invoice document of `company`, as the manual-pairing check finds it. */
export async function plantDocument(pool: Pool, type: 'customer_invoice' | 'supplier_invoice' | 'credit_note', company: string, by = U.ab): Promise<string> {
  const id = crypto.randomUUID();
  if (type === 'customer_invoice') {
    const customer = crypto.randomUUID();
    await pool.query('INSERT INTO customers(id, company_id, name) VALUES ($1, $2, $3)', [customer, company, `IC doc ${id.slice(0, 6)}`]);
    await pool.query(
      `INSERT INTO customer_invoices(id, company_id, invoice_number, customer_id, client_id, invoice_date, due_date, subtotal, tax_rate, tax_amount,
         total_amount, currency_code, exchange_rate, status, created_by)
       VALUES ($1, $2, $3, $4, $4, DATE '2026-09-01', DATE '2026-10-01', 1000, 15, 150, 1150, 'ZAR', 1, 'draft', $5)`,
      [id, company, `ICI-${id.slice(0, 8)}`, customer, by]);
    invoices.cust.push(id);
  } else if (type === 'supplier_invoice') {
    const supplier = crypto.randomUUID();
    await pool.query('INSERT INTO suppliers(id, company_id, name) VALUES ($1, $2, $3)', [supplier, company, `IC doc ${id.slice(0, 6)}`]);
    await pool.query(
      `INSERT INTO supplier_invoices(id, company_id, invoice_number, supplier_id, invoice_date, due_date, subtotal, tax_rate, tax_amount,
         total_amount, currency, currency_code, exchange_rate, status, created_by)
       VALUES ($1, $2, $3, $4, DATE '2026-09-01', DATE '2026-10-01', 1000, 15, 150, 1150, 'ZAR', 'ZAR', 1, 'draft', $5)`,
      [id, company, `ICS-${id.slice(0, 8)}`, supplier, by]);
    invoices.supp.push(id);
  } else {
    await pool.query(
      `INSERT INTO credit_notes(id, company_id, credit_note_number, type, credit_date, total_amount, created_by)
       VALUES ($1, $2, $3, 'customer', DATE '2026-09-05', 100, $4)`, [id, company, `ICN-${id.slice(0, 8)}`, by]);
    invoices.credit.push(id);
  }
  return id;
}

/** A link row with the links guard off (a superuser's DDL for the transaction): a fixture for tests of what is READ. */
export async function plantLink(pool: Pool, connection: string, over: Partial<{ doc_a: string; doc_b: string; status: string }> = {}): Promise<string> {
  const [low, high] = (await pool.query('SELECT company_low_id, company_high_id FROM intercompany_connections WHERE id = $1', [connection])).rows
    .map((r) => [r.company_low_id, r.company_high_id])[0] as [string, string];
  return withoutTrigger(pool, 'intercompany_document_links', 'trg_intercompany_links_guard', async (q) => (await q.query(
    `INSERT INTO intercompany_document_links(connection_id, company_a_id, doc_a_type, doc_a_id, company_b_id, doc_b_type, doc_b_id, origin, status, created_by)
     VALUES ($1, $2, 'customer_invoice', $4, $3, 'supplier_invoice', $5, 'manual_pairing', $6, $7) RETURNING id`,
    [connection, low, high, over.doc_a ?? crypto.randomUUID(), over.doc_b ?? crypto.randomUUID(), over.status ?? 'pending_confirmation', U.ab])).rows[0].id as string);
}

/** A message as superuser plants it (the guard still runs, with the sender's claims). */
export async function plantMessage(pool: Pool, connection: string, from: string, to: string, over: { kind?: string; doc?: string; user?: string } = {}): Promise<string> {
  return asAppUser(pool, over.user ?? U.ab, from, async (q) => (await q.query(
    `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload)
     VALUES ($1, $2, $3, $4, 'customer_invoice', $5, '{"number":"INV-1"}') RETURNING id`,
    [connection, from, to, over.kind ?? 'invoice', over.doc ?? crypto.randomUUID()])).rows[0].id as string, true);
}

/** The exact refusals of migration 999p, as `outcome` reports them: `<SQLSTATE>: <message>`. */
export const R = {
  externalNotYet: '0A000: external connections are not available yet',
  groupCreatedActive: '23514: a group connection is created active',
  needsOneGroup: '23514: a group connection needs both companies to be current members of one group',
  needsWriteBoth: '42501: a group connection needs a write role in both companies',
  reactivateWriteBoth: '42501: re-activating a group connection needs a write role in both companies',
  settingsWriteBoth: "42501: changing a group connection's settings needs a write role in both companies",
  settingsExternal: '23514: the settings of an external connection are agreed in its invitation',
  settingsRevoked: "23514: a revoked connection's settings cannot change",
  connImmutable: '23514: a connection changes only its status and its settings',
  statusNeedsUser: '42501: a connection changes status through a signed-in user',
  inviterAccepts: '42501: an invitation is accepted by the other company',
  partyAccepts: '42501: only a party to a connection accepts it',
  externalReinvite: '23514: a revoked external connection is invited again, not re-activated',
  noNoConnection: '23503: no such connection',
  sideRevoked: "23514: a revoked connection's sides cannot change",
  sidePairing: "23514: a side belongs to one of the connection's two companies, facing the other",
  sideKeeps: '23514: a side keeps its connection and its company',
  autoAcceptGroupOnly: '23514: auto-accept is only for a group connection',
  autoAcceptOneGroup: '23514: auto-accept needs both companies to be current members of one group',
  customerNotOwn: "23503: the customer is not this company's",
  supplierNotOwn: "23503: the supplier is not this company's",
  loanNotOwn: "23503: the loan account is not this company's",
  expenseNotOwn: "23503: the default expense account is not this company's",
  dimNotOwn: "23503: a default dimension is not this company's",
  msgNotActive: '23514: a message is sent only on an active connection',
  msgParties: "23514: a message goes between the connection's two companies",
  msgOneGroup: '23514: a group message needs both companies to be current members of one group',
  msgImmutable: '23514: a message changes only its handling',
  msgFinal: '23514: a handled message is final',
  msgDismissed: '23514: a dismissed message can only be restored',
  msgAcceptActive: '23514: a message is accepted only on an active connection',
  linkNotActive: '23514: documents are linked only on an active connection',
  linkOrder: "23514: a link names the connection's low company as A and its high company as B",
  linkParty: '42501: a link is made from a session of one of its two companies',
  linkUser: '42501: linking needs a signed-in user',
  mirrorNeedsMessage: '23514: a mirror link names its message',
  mirrorNoMessage: '23503: no such message on this connection',
  mirrorReceiver: '42501: a mirror link is made by the receiver of its message',
  mirrorAccepted: '23514: a mirror link needs an accepted message',
  mirrorDocs: "23514: a mirror link joins the message's source and target documents",
  manualNoMessage: '23514: a manual pairing names no message',
  docNotOwn: "23514: the document is not this company's",
  linkFinal: '23514: an unlinked link is final',
  linkImmutable: '23514: a link changes only its confirmation and its status',
  linkActivation: '23514: a link is activated by confirmation',
  linkUnlinkOnly: '23514: unlinking changes nothing else',
  linkConfirmed: '23514: a link is already confirmed on that side',
  linkConfirmRole: '42501: confirming needs a write role in the company (or in both, for a group)',
} as const;
