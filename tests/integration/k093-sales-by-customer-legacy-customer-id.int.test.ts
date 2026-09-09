// tests/integration/k093-sales-by-customer-legacy-customer-id.int.test.ts
//
// K-093. `pages/api/accounting/reports/sales-by-customer.ts` joins with
//
//     JOIN customers c ON c.id = ci.client_id
//
// `customer_invoices.customer_id` is NOT NULL; `client_id` is NULLABLE. Every
// invoice written before the client_id column was added — and every writer
// that still populates only customer_id — therefore has client_id NULL, and an
// inner join on a NULL key drops the row. The repo rule is to resolve the
// customer with COALESCE(ci.client_id, ci.customer_id) precisely because both
// columns are live.
//
// The report is not a partial view of sales; it silently under-reports them.
// This test seeds one modern invoice and one legacy invoice for the same
// company and asserts the report's total sales equals the ledger's.

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import type { NextApiRequest, NextApiResponse } from 'next';

// The route is wrapped in withAuth / withWriteAccess, which need a real GoTrue
// session. Neutralise the wrappers and supply companyId directly — the query
// under test is the route's own.
vi.mock('@/lib/auth', () => ({
  withAuth: (h: unknown) => h,
  withWriteAccess: (h: unknown) => h,
}));

const DATABASE_URL = process.env.DATABASE_URL;

const COMPANY = randomUUID();
const CUSTOMER_MODERN = randomUUID();
const CUSTOMER_LEGACY = randomUUID();

const CUSTOMER_BOUNDARY = randomUUID();

// A second tenant. One drifted invoice in COMPANY points at ITS customer row.
const OTHER_COMPANY = randomUUID();
const OTHER_CUSTOMER = randomUUID();

const MODERN_TOTAL = 1000;
const LEGACY_TOTAL = 2500;
const BOUNDARY_TOTAL = 700;   // legacy invoice dated exactly on `to`
const OUT_OF_RANGE_TOTAL = 9999;
const CANCELLED_TOTAL = 4444;
const DRIFTED_TOTAL = 3333;

const describeIfDb = DATABASE_URL ? describe : describe.skip;

interface SalesRow {
  clientId: string | null;
  clientName: string;
  invoiceCount: number;
  totalSales: number;
  paymentsReceived: number;
  outstanding: number;
}

describeIfDb('K-093 sales by customer must not drop legacy customer_id invoices', () => {
  let admin: Pool;
  let route: (req: NextApiRequest, res: NextApiResponse) => Promise<unknown>;

  beforeAll(async () => {
    const dbName = new URL(DATABASE_URL!).pathname.replace(/^\//, '');
    if (dbName === 'isaflow') throw new Error('Refusing to run against production.');

    admin = new Pool({ connectionString: DATABASE_URL, max: 2 });

    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K093 Sales Fixture', true)`,
      [COMPANY],
    );
    await admin.query(
      `INSERT INTO customers (id, company_id, name, is_active)
       VALUES ($2, $1, 'Modern Customer', true), ($3, $1, 'Legacy Customer', true)`,
      [COMPANY, CUSTOMER_MODERN, CUSTOMER_LEGACY],
    );

    // Modern shape: both columns populated.
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-MODERN', $2, $2, $3, $3, 0, 'sent', '2026-03-01', 'k093')`,
      [COMPANY, CUSTOMER_MODERN, MODERN_TOTAL],
    );

    // Legacy shape: customer_id only, client_id NULL. This is the row the
    // inner join discards.
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-LEGACY', $2, NULL, $3, $3, 0, 'sent', '2026-03-02', 'k093')`,
      [COMPANY, CUSTOMER_LEGACY, LEGACY_TOTAL],
    );

    // Legacy, dated exactly on the `to` boundary — must be included.
    await admin.query(
      `INSERT INTO customers (id, company_id, name, is_active) VALUES ($2, $1, 'Boundary Customer', true)`,
      [COMPANY, CUSTOMER_BOUNDARY],
    );
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-BOUNDARY', $2, NULL, $3, $3, 0, 'sent', '2026-12-31', 'k093')`,
      [COMPANY, CUSTOMER_BOUNDARY, BOUNDARY_TOTAL],
    );

    // Legacy, one day past the `to` boundary — must be excluded.
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-OUTSIDE', $2, NULL, $3, $3, 0, 'sent', '2027-01-01', 'k093')`,
      [COMPANY, CUSTOMER_LEGACY, OUT_OF_RANGE_TOTAL],
    );

    // Legacy and cancelled — must stay excluded once the join stops dropping it.
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-CANCELLED', $2, NULL, $3, $3, 0, 'cancelled', '2026-04-01', 'k093')`,
      [COMPANY, CUSTOMER_LEGACY, CANCELLED_TOTAL],
    );

    // Drifted data: an invoice in COMPANY whose customer row belongs to another
    // tenant. The customers side of the join carried no company scope.
    await admin.query(
      `INSERT INTO companies (id, name, is_active) VALUES ($1, 'K093 Other Tenant', true)`,
      [OTHER_COMPANY],
    );
    await admin.query(
      `INSERT INTO customers (id, company_id, name, is_active) VALUES ($2, $1, 'Other Tenant Customer', true)`,
      [OTHER_COMPANY, OTHER_CUSTOMER],
    );
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-DRIFT', $2, NULL, $3, $3, 0, 'sent', '2026-05-01', 'k093')`,
      [COMPANY, OTHER_CUSTOMER, DRIFTED_TOTAL],
    );

    route = (await import('../../pages/api/accounting/reports/sales-by-customer'))
      .default as unknown as typeof route;
  }, 60000);

  afterAll(async () => {
    if (!admin) return;
    const ids = [COMPANY, OTHER_COMPANY];
    await admin.query('DELETE FROM customer_invoices WHERE company_id = ANY($1)', [ids]);
    await admin.query('DELETE FROM customers WHERE company_id = ANY($1)', [ids]);
    await admin.query('DELETE FROM companies WHERE id = ANY($1)', [ids]);
    await admin.end();
  });

  it('reports every non-cancelled invoice in the period, legacy or not', async () => {
    const { rows } = await admin.query(
      `SELECT COALESCE(SUM(ci.total_amount), 0)::numeric AS total, COUNT(*)::int AS n
         FROM customer_invoices ci
         JOIN customers c ON c.id = COALESCE(ci.client_id, ci.customer_id)
                         AND c.company_id = ci.company_id
        WHERE ci.company_id = $1 AND ci.status <> 'cancelled'
          AND ci.invoice_date BETWEEN '2026-01-01' AND '2026-12-31'`,
      [COMPANY],
    );
    const ledgerTotal = Number(rows[0].total); // 1000 + 2500 + 700
    const ledgerCount = Number(rows[0].n);     // 3

    const res = mockRes();
    await route(
      {
        method: 'GET',
        query: { from: '2026-01-01', to: '2026-12-31' },
        headers: {},
        companyId: COMPANY,
        user: { id: 'k093' },
      } as unknown as NextApiRequest,
      res,
    );

    expect(res.statusCode).toBe(200);
    const data = (res.body as { data: SalesRow[] }).data;

    const reportTotal = data.reduce((a, r) => a + r.totalSales, 0);
    const reportInvoices = data.reduce((a, r) => a + r.invoiceCount, 0);

    // Today the legacy invoice is absent: 1000 of 3500, 1 invoice of 2.
    expect(reportInvoices).toBe(ledgerCount);
    expect(reportTotal).toBeCloseTo(ledgerTotal, 2);
    expect(data.map((r) => r.clientName).sort())
      .toEqual(['Boundary Customer', 'Legacy Customer', 'Modern Customer']);
  });

  it('still excludes cancelled and out-of-period legacy invoices', async () => {
    const res = mockRes();
    await route(
      {
        method: 'GET',
        query: { from: '2026-01-01', to: '2026-12-31' },
        headers: {},
        companyId: COMPANY,
        user: { id: 'k093' },
      } as unknown as NextApiRequest,
      res,
    );

    const data = (res.body as { data: SalesRow[] }).data;
    const legacy = data.find((r) => r.clientName === 'Legacy Customer');

    // The legacy customer has three invoices: R2,500 sent in period, R4,444
    // cancelled, R9,999 dated 2027-01-01. Only the first may be reported.
    expect(legacy?.invoiceCount).toBe(1);
    expect(legacy?.totalSales).toBeCloseTo(LEGACY_TOTAL, 2);

    const reportTotal = data.reduce((a, r) => a + r.totalSales, 0);
    expect(reportTotal).toBeCloseTo(MODERN_TOTAL + LEGACY_TOTAL + BOUNDARY_TOTAL, 2);
  });

  it('does not name another tenant\'s customer on a drifted invoice', async () => {
    const res = mockRes();
    await route(
      {
        method: 'GET',
        query: { from: '2026-01-01', to: '2026-12-31' },
        headers: {},
        companyId: COMPANY,
        user: { id: 'k093' },
      } as unknown as NextApiRequest,
      res,
    );

    const data = (res.body as { data: SalesRow[] }).data;
    expect(data.map((r) => r.clientName)).not.toContain('Other Tenant Customer');
    expect(data.map((r) => r.clientId)).not.toContain(OTHER_CUSTOMER);
    expect(data.reduce((a, r) => a + r.totalSales, 0)).not.toBeCloseTo(
      MODERN_TOTAL + LEGACY_TOTAL + BOUNDARY_TOTAL + DRIFTED_TOTAL, 2,
    );
  });

  it('carries the legacy invoice into the CSV download too', async () => {
    const res = mockRes();
    await route(
      {
        method: 'GET',
        query: { from: '2026-01-01', to: '2026-12-31', format: 'csv' },
        headers: {},
        companyId: COMPANY,
        user: { id: 'k093' },
      } as unknown as NextApiRequest,
      res,
    );

    const csv = String(res.body);
    expect(csv).toContain('"Legacy Customer",1,2500.00');
    expect(csv).toContain('"Boundary Customer",1,700.00');
    expect(csv).not.toContain('Other Tenant Customer');
  });
});

function mockRes() {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, unknown>,
    status(c: number) { this.statusCode = c; return this; },
    json(p: unknown) { this.body = p; return this; },
    send(p: unknown) { this.body = p; return this; },
    end(p?: unknown) { this.body = p; return this; },
    setHeader(k: string, v: unknown) { this.headers[k] = v; return this; },
  };
  return res as unknown as NextApiResponse & typeof res;
}
