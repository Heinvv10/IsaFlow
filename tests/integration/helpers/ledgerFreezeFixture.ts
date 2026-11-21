/**
 * Fixture for the ledger column immutability suites (migration 1018): a company with a chart and an open year, a member
 * user, a second company, and the three ways a test writes: as the fixture superuser (seeds shapes the app never
 * writes), as app_user the way withAuth opens a request (SET LOCAL ROLE, the member's claims, the active company), and
 * as another non-superuser role that bypasses RLS. Disposable databases only.
 */
import { randomUUID } from 'crypto';
import { Pool, type PoolClient } from 'pg';
import { expect } from 'vitest';
import { sql } from '@/lib/neon';
import { serviceDatabaseUrl } from '@/lib/serviceDatabaseUrl';
import { isDisposableDb } from '../../helpers/assertDisposableDb';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './lineRevenueFixture';

export type Row = Record<string, unknown>;
export interface Freeze { f: LineRevenueFixture; pool: Pool; ar: string; revenue: string; ap: string; expense: string }
/** [account id, debit, credit] */
export type Leg = [string, number, number];

const target = (url: string) => { const u = new URL(url); return `${u.hostname}:${u.port || '5432'}${u.pathname}`; };

/**
 * Round 11 (codex gate): every fixture write goes through `sql`, whose pool logs in with SERVICE_DATABASE_URL when it is
 * set (serviceDatabaseUrl), while the suites' guard reads DATABASE_URL. So, before any write, the URL `sql` uses must be
 * the very database DATABASE_URL names and that database must be disposable; then the live connection is checked too.
 */
export async function assertFixtureTarget(): Promise<void> {
  const validated = process.env.DATABASE_URL;
  const used = serviceDatabaseUrl();
  if (!validated || !isDisposableDb(validated) || !isDisposableDb(used) || target(used) !== target(validated)) {
    throw new Error(`ledgerFreezeFixture: refusing to write: sql would use ${target(used)}, the validated disposable database is `
      + `${validated ? target(validated) : '(none)'}`);
  }
  const probe = new Pool({ connectionString: validated, max: 1 });
  try {
    const want = (await probe.query('SELECT current_database() AS d, inet_server_port() AS p, pg_postmaster_start_time()::text AS t')).rows[0];
    const got = ((await sql`SELECT current_database() AS d, inet_server_port() AS p, pg_postmaster_start_time()::text AS t`) as Row[])[0]!;
    if (got.d !== want.d || got.p !== want.p || got.t !== want.t) throw new Error('ledgerFreezeFixture: sql is not on the validated database');
  } finally { await probe.end(); }
}

export async function seedFreeze(): Promise<Freeze> {
  await assertFixtureTarget();
  const f = await seedLineRevenue(process.env.DATABASE_URL!);
  const id = async (code: string) => String(((await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${f.fx.companyId}::UUID AND account_code = ${code}`) as Row[])[0]!.id);
  await sql`INSERT INTO users (id, email, role, is_active) VALUES (${f.fx.userId}, ${`lcf-${f.fx.userId}@isaflow.test`}, 'admin', true)`;
  await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${f.fx.companyId}::UUID, ${f.fx.userId}, 'admin')`;
  return { f, pool: new Pool({ connectionString: process.env.DATABASE_URL, max: 2 }), ar: await id('1100'), revenue: await id('4000'),
    ap: await id('2100'), expense: await id('6000') };
}

export async function dropFreeze(z: Freeze): Promise<void> {
  await z.pool.end();
  await assertFixtureTarget();
  for (const fx of [z.f.fx, z.f.other]) {
    const c = fx.companyId;
    await sql`DELETE FROM recurring_journals WHERE company_id = ${c}::UUID`;
    await sql`UPDATE customer_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`UPDATE supplier_invoices SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`UPDATE credit_notes SET gl_journal_entry_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`UPDATE gl_journal_entries SET reversal_of_id = NULL WHERE company_id = ${c}::UUID`;
    await sql`DELETE FROM credit_note_allocations WHERE credit_note_id IN (SELECT id FROM credit_notes WHERE company_id = ${c}::UUID)`;
    await sql`DELETE FROM supplier_invoice_items WHERE supplier_invoice_id IN (SELECT id FROM supplier_invoices WHERE company_id = ${c}::UUID)`;
  }
  await sql`DELETE FROM company_users WHERE company_id = ${z.f.fx.companyId}::UUID`;
  await sql`DELETE FROM users WHERE id = ${z.f.fx.userId}`;
  await dropLineRevenue(z.f);
}

/** One transaction as app_user the way withAuth opens one. Rolled back unless `commit`, so a forgery leaves no trace. */
export async function asApp<T>(z: Freeze, fn: (c: PoolClient) => Promise<T>, opts: { commit?: boolean } = {}): Promise<T> {
  const c = await z.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
    const out = await fn(c);
    await c.query(opts.commit ? 'COMMIT' : 'ROLLBACK');
    return out;
  } catch (err) {
    await c.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    c.release();
  }
}

/** One rolled-back transaction as a non-superuser role that bypasses RLS (migration_admin, platform_admin). */
export async function asRole<T>(z: Freeze, role: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await z.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SET LOCAL ROLE ${role}`);
    expect((await c.query("SELECT current_setting('is_superuser') AS su")).rows[0]!.su).toBe('off');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

/** The statement is refused by the database's rule (23514) with this wording; nothing it did survives. */
export async function refused(p: Promise<unknown>, wording: RegExp): Promise<void> {
  const err = await p.then(() => null, (e: unknown) => e as { code?: string; message?: string });
  expect(err, 'the write was accepted').not.toBeNull();
  expect(err!.message).toMatch(wording);
  expect(err!.code).toBe('23514');
}

/** A journal written as the fixture superuser (the shape no app path writes is seedable). */
export async function journal(z: Freeze, legs: Leg[], o: {
  status?: string; source?: string; claimed?: boolean; company?: string; date?: string; description?: string;
  /** The lines' own company_id when it is not the journal's (the legacy shape: a line of A inside B's journal). */
  lineCompany?: string;
} = {}): Promise<string> {
  const company = o.company ?? z.f.fx.companyId;
  const status = o.status ?? 'posted';
  const je = String(((await sql`
    INSERT INTO gl_journal_entries (company_id, entry_date, description, source, status, created_by, posted_at, reversed_at, reversed_by)
    VALUES (${company}::UUID, ${o.date ?? '2026-06-10'}::DATE, ${o.description ?? 'LCI journal'}, ${o.source ?? 'manual'}, ${status},
            ${z.f.fx.userId}::UUID, ${status === 'draft' ? null : new Date().toISOString()}::TIMESTAMPTZ,
            ${o.claimed ? new Date().toISOString() : null}::TIMESTAMPTZ, ${o.claimed ? z.f.fx.userId : null}::UUID)
    RETURNING id`) as Row[])[0]!.id);
  for (const [acct, debit, credit] of legs) {
    await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit)
      VALUES (${o.lineCompany ?? company}::UUID, ${je}::UUID, ${acct}::UUID, ${debit}, ${credit})`;
  }
  return je;
}

/** The same legs with debit and credit swapped. */
export const negate = (legs: Leg[]): Leg[] => legs.map(([a, d, c]) => [a, c, d]);

/** A customer invoice / supplier bill / credit note of the fixture company, written as the superuser, unlinked. */
export async function document(z: Freeze, kind: 'customer_invoices' | 'supplier_invoices' | 'credit_notes', o: {
  status?: string; link?: string | null; company?: string;
} = {}): Promise<string> {
  const fx = o.company === z.f.other.companyId ? z.f.other : z.f.fx;
  const tag = randomUUID().slice(0, 8);
  const link = o.link ?? null;
  if (kind === 'customer_invoices') {
    return String(((await sql`INSERT INTO customer_invoices (company_id, customer_id, invoice_number, invoice_date, due_date, subtotal,
        total_amount, amount_paid, status, created_by, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${fx.customerId}::UUID, ${`LCI-${tag}`}, '2026-06-10'::DATE, '2026-06-10'::DATE, 100, 100, 0,
        ${o.status ?? 'approved'}, ${fx.userId}::UUID, ${link}::UUID) RETURNING id`) as Row[])[0]!.id);
  }
  if (kind === 'supplier_invoices') {
    return String(((await sql`INSERT INTO supplier_invoices (company_id, supplier_id, invoice_number, invoice_date, due_date, subtotal,
        total_amount, amount_paid, status, created_by, gl_journal_entry_id)
      VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${`LCI-${tag}`}, '2026-06-10'::DATE, '2026-06-10'::DATE, 100, 100, 0,
        ${o.status ?? 'approved'}, ${fx.userId}::UUID, ${link}::UUID) RETURNING id`) as Row[])[0]!.id);
  }
  return String(((await sql`INSERT INTO credit_notes (company_id, type, credit_note_number, client_id, credit_date, subtotal, total_amount,
      status, created_by, gl_journal_entry_id)
    VALUES (${fx.companyId}::UUID, 'customer', ${`LCI-${tag}`}, ${fx.customerId}::UUID, '2026-06-10'::DATE, 100, 100,
      ${o.status ?? 'approved'}, ${fx.userId}::UUID, ${link}::UUID) RETURNING id`) as Row[])[0]!.id);
}

/** A transaction left open as app_user (the caller commits or rolls back and releases): for two-session races. */
export async function openApp(z: Freeze): Promise<PoolClient> {
  const c = await z.pool.connect();
  await c.query('BEGIN');
  await c.query('SET LOCAL ROLE app_user');
  await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: z.f.fx.userId, role: 'authenticated' })]);
  await c.query("SELECT set_config('app.current_company_id', $1, true)", [z.f.fx.companyId]);
  return c;
}

/** A posted contra of `original` with `legs` negated, linked as the superuser (the ledger's own reversal). Returns its id. */
export async function reverseAsSuperuser(z: Freeze, original: string, legs: Leg[]): Promise<string> {
  const contra = await journal(z, negate(legs));
  await sql`UPDATE gl_journal_entries SET reversal_of_id = ${original}::UUID, reversed_at = now() WHERE id = ${contra}::UUID`;
  return contra;
}

/**
 * Link `contra` as the reversal of `original` by hand as app_user, inside the caller's app_user transaction (`c`).
 * Round 11 (M1): the link is accepted only in the transaction that claimed the original (reversed_at = now()) and
 * created the contra (created_at = now()), as reverseJournalEntry does. A fixture contra was written earlier by the
 * superuser, so this first stages that state as the session's superuser (SET LOCAL ROLE NONE) in the SAME transaction,
 * then links as the caller's role again: every other rule of the link is still judged as that role. It re-stamps the
 * contra's created_at, which ledger_link_key reads, so a race test must not hold the contra's key from another session.
 */
export async function linkAsApp(c: PoolClient, contra: string, original: string) {
  const role = String((await c.query("SELECT current_setting('role') AS r")).rows[0].r); // app_user, or asRole's role
  await c.query('SET LOCAL ROLE NONE');
  await c.query('UPDATE gl_journal_entries SET created_at = now() WHERE id = $1', [contra]);
  await c.query('UPDATE gl_journal_entries SET reversed_at = now(), reversed_by = COALESCE(reversed_by, created_by) WHERE id = $1', [original]);
  await c.query(`SET LOCAL ROLE ${role}`);
  return c.query('UPDATE gl_journal_entries SET reversal_of_id = $1 WHERE id = $2', [original, contra]);
}
