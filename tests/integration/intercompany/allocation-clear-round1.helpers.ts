/**
 * P4-D fix round 1 fixtures: an accepted clearing of the SAME payer payment by ANOTHER receiver (C), planted as the table owner (C has no
 * connection to B in the fixture: the guard is off for the one INSERT; the definer's cross-receiver count reads only the message, its target
 * receipt and that receipt's journal); the clearing's advisory locks held by a session of the test; the posted-line freezes off for a tamper.
 */
import type { Pool, PoolClient } from 'pg';
import { SignJWT } from 'jose';
import { co, U, withoutTrigger } from './intercompany.helpers';

/** A posted, balanced two-line journal of `company` on two fresh accounts of its own. */
export async function plantPostedPair(pool: Pool, company: string, amount: number): Promise<string> {
  const [dr, cr] = [crypto.randomUUID(), crypto.randomUUID()];
  for (const [id, code] of [[dr, 'D'], [cr, 'K']] as const) {
    await pool.query(
      `INSERT INTO gl_accounts(id, company_id, account_code, account_name, account_type, normal_balance, is_active, account_subtype)
       VALUES ($1, $2, $3, $3, 'asset', 'debit', true, 'other_current_asset')`, [id, company, `IX${code}${id.slice(0, 6)}`]);
  }
  const je = (await pool.query(
    `INSERT INTO gl_journal_entries(entry_date, description, source, status, created_by, company_id) VALUES (DATE '2026-09-01', 'planted clearing', 'auto_payment', 'draft', $1, $2) RETURNING id`,
    [U.ab, company])).rows[0].id as string;
  await pool.query('INSERT INTO gl_journal_lines(journal_entry_id, gl_account_id, debit, credit, company_id, description) VALUES ($1, $2, $3, 0, $4, $5), ($1, $6, 0, $3, $4, $5)',
    [je, dr, amount, company, 'planted', cr]);
  await pool.query("UPDATE gl_journal_entries SET status = 'posted', posted_at = now() WHERE id = $1", [je]);
  return je;
}

/** C's accepted clearing of B's payment `payment` (amount), on the journal B's message recorded: what another receiver's Accept leaves. */
export async function plantForeignClearing(pool: Pool, conn: string, s: { message: string; journal: string | null }, amount: number): Promise<string> {
  const je = await plantPostedPair(pool, co.C, amount);
  const customer = crypto.randomUUID();
  await pool.query("INSERT INTO customers(id, company_id, name) VALUES ($1, $2, 'IC C customer')", [customer, co.C]);
  const receipt = (await pool.query(
    `INSERT INTO customer_payments(company_id, client_id, payment_date, total_amount, payment_method, status, gl_journal_entry_id, created_by)
     VALUES ($1, $2, DATE '2026-09-01', $3, 'contra', 'confirmed', $4, $5) RETURNING id`, [co.C, customer, amount, je, U.c])).rows[0].id as string;
  const payload = (await pool.query('SELECT payload FROM intercompany_messages WHERE id = $1', [s.message])).rows[0].payload as Record<string, unknown>;
  return withoutTrigger(pool, 'intercompany_messages', 'trg_intercompany_messages_guard', async (q) => (await q.query(
    `INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload, source_journal_entry_id,
       status, target_doc_type, target_doc_id, handled_at)
     VALUES ($1, $2, $3, 'allocation', 'payment_allocation', $4, $5::jsonb, $6, 'accepted', 'customer_payment', $7, now()) RETURNING id`,
    [conn, co.B, co.C, crypto.randomUUID(), JSON.stringify({ ...payload, amount }), s.journal, receipt])).rows[0].id as string);
}

/** A session of the receiver (another request of A's: the cap lock is the receiver's only) holding the clearing's advisory locks for
 *  `message`, as the service and the guard take them, until `release`. */
export async function holdCapLock(pool: Pool, message: string): Promise<{ release: () => Promise<void> }> {
  const client = await pool.connect();
  await client.query('BEGIN');
  await client.query('SET LOCAL ROLE app_user');
  await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.a })]);
  await client.query("SELECT set_config('app.current_company_id', $1, true)", [co.A]);
  await client.query('SELECT public.intercompany_allocation_cap_lock($1)', [message]);
  return { release: async () => { await client.query('COMMIT'); client.release(); } };
}

/** Run `fn` with the posted-line and posted-entry freezes off (a superuser's DDL), committed; each is back ON ALWAYS in a second transaction
 *  (an UPDATE of a line queues the deferred balance check, and a table with pending trigger events cannot be altered in the same transaction). */
export async function withLedgerUnfrozen(pool: Pool, fn: (q: PoolClient) => Promise<unknown>): Promise<void> {
  const off: [string, string][] = [
    ['gl_journal_lines', 'trg_gl_jl_posted_frozen'], ['gl_journal_lines', 'trg_gl_jl_posted_set_frozen'], ['gl_journal_lines', 'trg_gl_jl_posted_balanced'],
  ];
  const entries = (await pool.query("SELECT tgname FROM pg_trigger WHERE tgrelid = 'gl_journal_entries'::regclass AND NOT tgisinternal AND tgenabled = 'A'")).rows.map((r) => r.tgname as string);
  for (const t of entries) off.push(['gl_journal_entries', t]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [table, t] of off) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${t}`);
    await fn(client);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    for (const [table, t] of off) await client.query(`ALTER TABLE ${table} ENABLE ALWAYS TRIGGER ${t}`);
    client.release();
  }
}

/** A signed token with no session id: what a bearer caller (MCP, a personal token) carries. */
export const sessionlessToken = (user: string) => new SignJWT({ sub: user, aal: 'aal2' })
  .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h').sign(new TextEncoder().encode(process.env.JWT_SECRET));
