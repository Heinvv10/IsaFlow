/**
 * D12 (no write may change a COMPLETED bank reconciliation) — shared fixture for the d12-*.int.test.ts files on the
 * d8-r4 fixture (isaflow_test). Each scenario gets its own bank GL account, so its sessions never meet another's
 * (reopen is newest-first per account). A completed session is built THROUGH THE PRODUCT: start (route), match into
 * the session (route), complete (route) — never seeded as rows.
 */
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { sql } from '@/lib/neon';
import bankReconciliations from '../../pages/api/accounting/bank-reconciliations';
import bankReconciliationsAction from '../../pages/api/accounting/bank-reconciliations-action';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { runOn } from './helpers/l1FifoFixture';
import type { Ctx } from './d8-r4-helpers';

type Row = Record<string, unknown>;
export type Route = (q: never, s: never) => unknown;
export const routes = {
  start: bankReconciliations as Route, recon: bankReconciliationsAction as Route, tx: bankTransactionsAction as Route,
};
export const STATEMENT_DATE = '2026-06-30';

export interface Call { status: number; ms: number; retryAfter: string | null; body: string; data: unknown }

export async function call(c: Ctx, token: string, route: Route, body: Record<string, unknown>,
  query: Record<string, string> = {}): Promise<Call> {
  const req = request({ 'sb-access-token': token, active_company_id: c.fx.companyId }, 'POST') as unknown as Row;
  req.body = body; req.query = query;
  const out = response();
  const t0 = Date.now();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, ms: Date.now() - t0, retryAfter: (out.headers.get('retry-after') as string) ?? null,
    body: JSON.stringify(out.state.body ?? null).slice(0, 600), data: (out.state.body as { data?: unknown } | undefined)?.data };
}

/** A bank GL account of the scenario's own. */
export async function newBank(c: Ctx): Promise<string> {
  return String(((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype, normal_balance,
      is_active, is_system_account)
    VALUES (${c.fx.companyId}::UUID, ${`9${String(++c.seq).padStart(3, '0')}`}, ${`D12 bank ${c.seq} ${c.fx.tag}`},
      'asset', 'bank', 'debit', true, false) RETURNING id`) as Row[])[0]!.id);
}

/**
 * A posted payment journal (expense DR, bank CR `amount`) and an imported statement line of `-amount` on `bank` — the
 * pairing `utils/autoMatch` makes: money out credits the bank account, so a withdrawal takes the bank CREDIT leg.
 */
export async function seedPair(c: Ctx, bank: string, amount: number, date = '2026-06-10') {
  const tag = `D12 ${++c.seq}`;
  const [je] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c.fx.companyId}::UUID, ${date}::DATE, ${tag}, 'posted', ${c.fx.userId}::UUID) RETURNING id`) as Row[];
  const [jl] = (await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${bank}::UUID, 0, ${amount}, ${tag}) RETURNING id`) as Row[];
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${c.acct.expense}::UUID, ${amount}, 0, ${tag})`;
  const [bt] = (await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, ${date}::DATE, ${-amount}, ${tag}, 'imported') RETURNING id`) as Row[];
  return { bt: String(bt!.id), je: String(je!.id), jl: String(jl!.id) };
}

/** An imported statement line of `-amount` with no journal. */
export async function seedLine(c: Ctx, bank: string, amount: number, date = '2026-06-15'): Promise<string> {
  return String(((await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${c.fx.companyId}::UUID, ${bank}::UUID, ${date}::DATE, ${-amount}, ${`D12 line ${++c.seq}`}, 'imported')
    RETURNING id`) as Row[])[0]!.id);
}

/** A GL line on `bank` with no statement line (a match target). */
export async function seedJournal(c: Ctx, bank: string, amount: number, date = '2026-06-12'): Promise<string> {
  const p = await seedPair(c, bank, amount, date);
  await sql`DELETE FROM bank_transactions WHERE id = ${p.bt}::UUID`;
  return p.jl;
}

async function glBalance(bank: string, companyId: string): Promise<number> {
  return Number(((await sql`SELECT COALESCE(SUM(l.debit - l.credit), 0)::float8 AS b FROM gl_journal_lines l
    JOIN gl_journal_entries e ON e.id = l.journal_entry_id
    WHERE l.gl_account_id = ${bank}::UUID AND l.company_id = ${companyId}::UUID AND e.status = 'posted'
      AND e.entry_date <= ${STATEMENT_DATE}::DATE`) as Row[])[0]!.b);
}

export async function startSession(c: Ctx, token: string, bank: string): Promise<string> {
  const out = await call(c, token, routes.start,
    { bankAccountId: bank, statementDate: STATEMENT_DATE, statementBalance: await glBalance(bank, c.fx.companyId) });
  if (out.status >= 300) throw new Error(`start: ${JSON.stringify(out)}`);
  return String((out.data as { id: string }).id);
}

export async function matchInto(c: Ctx, token: string, rec: string, p: { bt: string; jl: string }) {
  const out = await call(c, token, routes.tx, { action: 'match', bankTransactionId: p.bt, journalLineId: p.jl, reconciliationId: rec });
  if (out.status >= 300) throw new Error(`match: ${JSON.stringify(out)}`);
}

/**
 * A COMPLETED session on its own bank account: `matched` lines matched into it (reconciled at completion), plus
 * `stale` lines it claimed and never matched — left 'imported' carrying its id (a stale stamp).
 */
export async function completedSession(c: Ctx, token: string, opts: { matched?: number; stale?: number } = {}) {
  const bank = await newBank(c);
  const matched = [];
  for (let i = 0; i < (opts.matched ?? 2); i++) matched.push(await seedPair(c, bank, 100 + i, `2026-06-0${i + 1}`));
  // A stale line is a statement line with no journal behind it: start claims it, nothing matches it.
  const stale: string[] = [];
  for (let i = 0; i < (opts.stale ?? 0); i++) stale.push(await seedLine(c, bank, 300 + i, `2026-06-1${i + 1}`));
  const rec = await startSession(c, token, bank);
  for (const p of matched) await matchInto(c, token, rec, p);
  const done = await call(c, token, routes.recon, { action: 'complete', reconciliationId: rec });
  if (done.status >= 300) throw new Error(`complete: ${JSON.stringify(done)}`);
  return { bank, rec, matched, stale };
}

/** Everything a refused write must leave unchanged: the account's lines, the header, and the company's journals. */
export async function snapshot(c: Ctx, bank: string, rec: string) {
  const lines = (await sql`SELECT id::TEXT AS id, status, matched_journal_line_id::TEXT AS jl, reconciliation_id::TEXT AS rec
    FROM bank_transactions WHERE bank_account_id = ${bank}::UUID AND company_id = ${c.fx.companyId}::UUID ORDER BY id`) as Row[];
  const header = ((await sql`SELECT status, gl_balance::float8 AS gl, reconciled_balance::float8 AS rb,
      statement_balance::float8 AS sb, completed_at::TEXT AS at
    FROM bank_reconciliations WHERE id = ${rec}::UUID`) as Row[])[0] ?? null;
  const journals = Number(((await sql`SELECT COUNT(*) AS n FROM gl_journal_entries
    WHERE company_id = ${c.fx.companyId}::UUID`) as Row[])[0]!.n);
  return { lines, header, journals };
}

export const lineOf = async (id: string) => ((await sql`SELECT status, matched_journal_line_id::TEXT AS jl,
  reconciliation_id::TEXT AS rec FROM bank_transactions WHERE id = ${id}::UUID`) as Row[])[0]!;

/**
 * A completed session's invariant: no line carries its id as 'matched', and (`gl`, for a race with no journal posted
 * after it) its signed-off GL figure is the live one.
 */
export async function completedInvariant(c: Ctx, bank: string, rec: string, gl = false): Promise<string | null> {
  const h = ((await sql`SELECT status, gl_balance::float8 AS gl FROM bank_reconciliations WHERE id = ${rec}::UUID`) as Row[])[0];
  if (!h || h.status !== 'completed') return null;
  const stray = (await sql`SELECT id FROM bank_transactions WHERE reconciliation_id = ${rec}::UUID AND status = 'matched'`) as Row[];
  if (stray.length) return `${stray.length} line(s) 'matched' on the completed session`;
  if (!gl) return null;
  const live = await glBalance(bank, c.fx.companyId);
  return Math.abs(live - Number(h.gl)) > 0.005 ? `signed off GL ${String(h.gl)} but the ledger says ${live}` : null;
}

/** Work done on its own connection and NOT committed — its locks held — until `commit`/`rollback`. */
export async function heldWork<T>(c: Ctx, fn: () => Promise<T>) {
  const cl: PoolClient = await c.fx.pool.connect();
  await cl.query('BEGIN');
  let value: T | undefined;
  let error: unknown = null;
  try { value = await runOn(c.fx, cl, fn); } catch (e) { error = e; }
  const end = async (verb: 'COMMIT' | 'ROLLBACK') => { await cl.query(error ? 'ROLLBACK' : verb); cl.release(); };
  return { value, error, commit: () => end('COMMIT'), rollback: () => end('ROLLBACK') };
}

/** Hold a raw row lock on the session for `ms` on its own connection. */
export async function holdSession(c: Ctx, rec: string, mode: 'UPDATE' | 'SHARE', ms = 9000) {
  const h: PoolClient = await c.fx.pool.connect();
  await h.query('BEGIN');
  await h.query(`SELECT id FROM bank_reconciliations WHERE id = $1 FOR ${mode}`, [rec]);
  let done = false;
  const release = async () => { if (done) return; done = true; clearTimeout(timer); await h.query('ROLLBACK').catch(() => undefined); h.release(); };
  const timer = setTimeout(() => { void release(); }, ms);
  return release;
}

/** Settled within `ms`? (A writer that waits on a lock is still pending.) */
export async function settledWithin(p: Promise<unknown>, ms: number): Promise<boolean> {
  let settled = false;
  void p.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((r) => setTimeout(r, ms));
  return settled;
}

export async function cleanup(c: Ctx | undefined): Promise<void> {
  if (!c) return;
  await sql`UPDATE bank_transactions SET reconciliation_id = NULL WHERE company_id = ${c.fx.companyId}::UUID`;
  await sql`DELETE FROM bank_reconciliations WHERE company_id = ${c.fx.companyId}::UUID`;
}

export const newId = () => randomUUID();
