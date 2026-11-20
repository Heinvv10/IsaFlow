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
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './lineRevenueFixture';

export type Row = Record<string, unknown>;
export interface Freeze { f: LineRevenueFixture; pool: Pool; ar: string; revenue: string; ap: string; expense: string }
/** [account id, debit, credit] */
export type Leg = [string, number, number];

export async function seedFreeze(): Promise<Freeze> {
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
  for (const fx of [z.f.fx, z.f.other]) {
    const c = fx.companyId;
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
