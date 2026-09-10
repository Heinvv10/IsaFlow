/**
 * K-125 (M4) — NULL amount_paid must not silently drop an invoice from the
 * reports that feed the financial statements.
 *
 * `total_amount - amount_paid` is NULL when amount_paid is NULL, so the row
 * fails the `> 0` filter and contributes NULL to the SUM. K-125 fixed only
 * debtorsManagerService, which left the debtors page and the AR aging report /
 * AFS disclosure notes reporting different receivables for the same data.
 *
 * The auth/error wrappers are stubbed pass-through (the established pattern in
 * tests/unit/services/cashFlowReport.test.ts) so the REAL handler SQL runs
 * against the fixture database.
 */
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { NextApiRequest, NextApiResponse } from 'next';
import { Pool } from 'pg';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

vi.mock('@/lib/auth', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...original,
    withAuth: (fn: (req: NextApiRequest, res: NextApiResponse) => unknown) => fn,
    withWriteAccess: (fn: (req: NextApiRequest, res: NextApiResponse) => unknown) => fn,
  };
});
vi.mock('@/lib/api-error-handler', () => ({
  withErrorHandler: (fn: (req: NextApiRequest, res: NextApiResponse) => unknown) => fn,
}));

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const company = crypto.randomUUID(), user = crypto.randomUUID(), customer = crypto.randomUUID();
const paidSome = crypto.randomUUID(), neverPaid = crypto.randomUUID();
const legacy = crypto.randomUUID();

interface AgingBody {
  success: boolean;
  data: {
    rows: Array<{ id: string; balance_due: number; amount_paid: number }>;
    summary: Array<{ bucket: string; count: number; total: number }>;
  };
}

function makeRes(): { res: NextApiResponse; body: () => AgingBody } {
  let captured: unknown = null;
  const res = {
    status: () => res,
    json: (b: unknown) => { captured = b; return res; },
    setHeader: () => res,
    end: () => res,
  } as unknown as NextApiResponse;
  return { res, body: () => captured as AgingBody };
}

beforeAll(async () => {
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [company, 'K125b fixture']);
  await pool.query("INSERT INTO users(id,email,role,is_active) VALUES($1,$2,'admin',true)", [user, `${user}@test.local`]);
  await pool.query('INSERT INTO customers(id,company_id,name) VALUES($1,$2,$3)', [customer, company, 'K125b customer']);
  // amount_paid 400 — the row that always worked.
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,'K125B-PAID',$3,$3,'2026-01-01','2026-01-31',1000,150,1150,400,'approved',$4)`,
    [paidSome, company, customer, user]);
  // amount_paid NULL — never paid a cent, and therefore invisible.
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,'K125B-NULL',$3,$3,'2026-01-01','2026-01-31',2000,300,2300,NULL,'approved',$4)`,
    [neverPaid, company, customer, user]);
  // client_id NULL — the migrated invoice the whole COALESCE(client_id,
  // customer_id) rule exists for. It is what the aging report and the debtors
  // page disagreed about: the report joined on the COALESCE, the debtors
  // service still joined on bare client_id and dropped the row entirely.
  await pool.query(
    `INSERT INTO customer_invoices(id,company_id,invoice_number,customer_id,client_id,invoice_date,due_date,subtotal,tax_amount,total_amount,amount_paid,status,created_by)
     VALUES($1,$2,'K125B-LEGACY',$3,NULL,'2026-01-01','2026-01-31',1000,150,1150,NULL,'approved',$4)`,
    [legacy, company, customer, user]);
});

afterAll(async () => {
  try {
    await pool.query('DELETE FROM customer_invoices WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM customers WHERE company_id=$1', [company]);
    await pool.query('DELETE FROM companies WHERE id=$1', [company]);
    await pool.query('DELETE FROM users WHERE id=$1', [user]);
  } finally { await pool.end(); }
});

it('lists the NULL-amount_paid invoice in the AR aging report at its full balance', async () => {
  const mod = await import('../../pages/api/accounting/reports-ar-aging');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const { res, body } = makeRes();

  await handler({ method: 'GET', query: {}, companyId: company } as unknown as NextApiRequest, res);

  const invoices = body().data.rows;
  expect(invoices.map(i => i.id).sort()).toEqual([paidSome, neverPaid, legacy].sort());

  const nullRow = invoices.find(i => i.id === neverPaid)!;
  expect(nullRow.balance_due).toBeCloseTo(2300, 2);
  expect(nullRow.amount_paid).toBe(0);          // not NaN
  expect(invoices.find(i => i.id === paidSome)!.balance_due).toBeCloseTo(750, 2);
});

it('includes it in the aging bucket SUM, which the debtors page already counted', async () => {
  const mod = await import('../../pages/api/accounting/reports-ar-aging');
  const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
  const { res, body } = makeRes();

  await handler({ method: 'GET', query: {}, companyId: company } as unknown as NextApiRequest, res);

  const bucketTotal = body().data.summary.reduce((s, b) => s + Number(b.total), 0);
  expect(bucketTotal).toBeCloseTo(4200, 2);     // 750 + 2300 + 1150 (legacy)

  const { getDebtorsSummary } = await import('../../src/modules/accounting/services/ar/debtorsManagerService');
  const debtors = await getDebtorsSummary(company);
  const debtorsTotal = debtors.reduce((s, d) => s + Number(d.totalOutstanding), 0);

  // The point of M4: these two must agree for the same data.
  expect(bucketTotal).toBeCloseTo(debtorsTotal, 2);
});

it('exposes a custom-report balance expression that survives a NULL amount_paid', async () => {
  const { getFieldDef } = await import('../../src/modules/accounting/services/reports/customReportFieldDefs');
  const def = getFieldDef('customer_invoices', 'balance')!;

  const { rows } = await pool.query(
    `SELECT SUM(${def.sqlExpr})::numeric AS total FROM customer_invoices ci WHERE ci.company_id = $1`,
    [company]);
  expect(Number(rows[0].total)).toBeCloseTo(4200, 2);
});

it('does not leak the NULL-amount_paid invoice into another tenant’s aging report', async () => {
  const other = crypto.randomUUID();
  await pool.query('INSERT INTO companies(id,name) VALUES($1,$2)', [other, 'K125b other tenant']);
  try {
    const mod = await import('../../pages/api/accounting/reports-ar-aging');
    const handler = mod.default as (req: NextApiRequest, res: NextApiResponse) => Promise<void>;
    const { res, body } = makeRes();
    await handler({ method: 'GET', query: {}, companyId: other } as unknown as NextApiRequest, res);
    expect(body().data.rows).toHaveLength(0);
  } finally {
    await pool.query('DELETE FROM companies WHERE id=$1', [other]);
  }
});

it('shows the legacy client_id-NULL invoice on every debtors surface, not just the tiles', async () => {
  const {
    getDebtorsSummary, getDebtorDetail, getOverdueInvoices, getCollectionStats,
  } = await import('../../src/modules/accounting/services/ar/debtorsManagerService');

  // The debtors page and its own tiles disagreed: getCollectionStats has no
  // customers join and counted the row, while every list joined bare
  // client_id and dropped it.
  const stats = await getCollectionStats(company);
  const summary = await getDebtorsSummary(company);
  expect(summary.reduce((s, d) => s + d.totalOutstanding, 0)).toBeCloseTo(stats.totalOutstanding, 2);
  expect(summary.reduce((s, d) => s + d.invoiceCount, 0)).toBe(3);

  const overdue = await getOverdueInvoices(company);
  expect(overdue.map(i => i.id).sort()).toEqual([paidSome, neverPaid, legacy].sort());
  expect(overdue.find(i => i.id === legacy)!.clientName).toBe('K125b customer');

  const detail = await getDebtorDetail(company, customer);
  expect(detail.map(i => i.id).sort()).toEqual([paidSome, neverPaid, legacy].sort());
});
