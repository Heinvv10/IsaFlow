/**
 * Shared set-up for the Connect to Sage integration suites: a company made and
 * rolled back inside one transaction, a pull stored as the pull job stores it,
 * the import run as its route runs it, and counts of everything a take-on
 * writes. The suites call assertDisposable() themselves.
 */
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'crypto';
import { expect } from 'vitest';
import { als } from '@/lib/als';
import { withSavepoint } from '@/lib/neon';
import type { SagePull } from '@/modules/accounting/services/sage/sageApiTypes';
import { markPullReady, readTakeOnContext, startPull, summarise } from '@/modules/accounting/services/sage/sageTakeOnStore';
import { importSagePull } from '@/modules/accounting/services/sage/sageTakeOnImportService';
import { buildSageTakeOn } from '@/modules/accounting/services/sage/sageTakeOnBuilder';

/** Twelve monthly periods of one fiscal year from `start` (YYYY-MM-01), as the fiscal-year setup lays them out. */
export async function fiscalYear(c: PoolClient, companyId: string, start: string, label: number) {
  await c.query(
    `INSERT INTO fiscal_periods (company_id, period_name, period_number, fiscal_year, start_date, end_date)
     SELECT $1, to_char(m, 'Mon YYYY'), n, $3, m::DATE, (m + INTERVAL '1 month - 1 day')::DATE
     FROM generate_series(1, 12) n, LATERAL (SELECT $2::DATE + (n - 1) * INTERVAL '1 month' AS m) x`,
    [companyId, start, label],
  );
}

export async function inRolledBackCompany(
  pool: Pool,
  fn: (c: PoolClient, companyId: string, userId: string) => Promise<void>,
  yearStart: string | null = '2026-03-01',
) {
  const c = await pool.connect();
  const companyId = randomUUID();
  const userId = randomUUID();
  await c.query('BEGIN');
  try {
    await c.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [userId, `${userId}@test.local`]);
    await c.query('INSERT INTO companies(id,name) VALUES($1,$2)', [companyId, 'Sage connect take-on']);
    await c.query("INSERT INTO company_users(company_id,user_id,role) VALUES($1,$2,'admin')", [companyId, userId]);
    // A new company gets the seeded chart, as onboarding does.
    await c.query('SELECT public.seed_company_chart_of_accounts($1)', [companyId]);
    // Sage's year (sageFixture) starts 2026-03-01: so does IsaFlow's, unless the test says otherwise.
    if (yearStart) await fiscalYear(c, companyId, yearStart, 2027);
    await als.run({ client: c, userId, companyId, claims: {} } as never, () => fn(c, companyId, userId));
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}

/** Store `pull` as a ready review, as the pull job does. */
export async function storeReady(companyId: string, userId: string, pull: SagePull): Promise<string> {
  const pullId = await startPull(companyId, userId, pull.company.id, pull.asAtDate);
  const summary = summarise(buildSageTakeOn(pull, await readTakeOnContext(companyId, pull.asAtDate)));
  expect(await markPullReady(companyId, pullId, pull, summary)).toBe(true);
  return pullId;
}

/** As the import route runs it: a refusal rolls the savepoint back, then the request commits its 400. */
export const importAsRoute = (companyId: string, userId: string, pullId: string) =>
  withSavepoint('sage_import_test', () => importSagePull(companyId, userId, pullId));

export const balanceOf = async (c: PoolClient, companyId: string, where: string, params: unknown[] = []) => Number((await c.query(
  `SELECT COALESCE(SUM(l.debit - l.credit), 0) AS b
     FROM gl_journal_lines l
     JOIN gl_accounts a ON a.id = l.gl_account_id AND a.company_id = $1
     JOIN gl_journal_entries e ON e.id = l.journal_entry_id AND e.company_id = $1
    WHERE l.company_id = $1 AND e.status = 'posted' AND ${where}`, [companyId, ...params],
)).rows[0]!.b);

/** Everything a take-on writes, counted, so a refusal can be shown to have written none of it. */
export async function books(c: PoolClient, companyId: string) {
  const count = async (table: string) => Number((await c.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE company_id = $1`, [companyId])).rows[0]!.n);
  return {
    accounts: await count('gl_accounts'),
    customers: await count('customers'),
    suppliers: await count('suppliers'),
    journals: await count('gl_journal_entries'),
    lines: await count('gl_journal_lines'),
    sessions: await count('migration_sessions'),
    customerInvoices: await count('customer_invoices'),
    supplierInvoices: await count('supplier_invoices'),
    accountNames: (await c.query('SELECT string_agg(account_code || account_name, \',\' ORDER BY account_code) AS s FROM gl_accounts WHERE company_id = $1', [companyId])).rows[0]!.s as string,
  };
}

export const statusOf = async (c: PoolClient, pullId: string) =>
  (await c.query('SELECT status, pull IS NOT NULL AS has_pull FROM sage_connect_pulls WHERE id = $1', [pullId])).rows[0];

