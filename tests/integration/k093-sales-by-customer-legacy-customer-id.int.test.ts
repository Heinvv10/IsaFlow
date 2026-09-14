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

const CUSTOMER_NULL_STATUS = randomUUID();

// A second tenant. Two drifted invoices in COMPANY point at ITS customer rows.
// Two, because one placeholder per unresolved id is the whole point of LOW-2:
// a single 'Unknown customer' label would collapse two unattributable rows into
// two identical CSV lines that neither aggregate nor can be told apart.
const OTHER_COMPANY = randomUUID();
const OTHER_CUSTOMER = randomUUID();
const OTHER_CUSTOMER_2 = randomUUID();

const MODERN_TOTAL = 1000;
const LEGACY_TOTAL = 2500;
const BOUNDARY_TOTAL = 700;   // legacy invoice dated exactly on `to`
const OUT_OF_RANGE_TOTAL = 9999;
const CANCELLED_TOTAL = 4444;
const DRIFTED_TOTAL = 3333;
const DRIFTED_TOTAL_2 = 1111;
const NULL_STATUS_TOTAL = 555;   // status explicitly NULL, not 'draft'
const NULL_PAID_TOTAL = 1200;  // amount_paid NULL, not 0

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
      `INSERT INTO customers (id, company_id, name, is_active)
       VALUES ($2, $1, 'Other Tenant Customer', true), ($3, $1, 'Other Tenant Customer 2', true)`,
      [OTHER_COMPANY, OTHER_CUSTOMER, OTHER_CUSTOMER_2],
    );
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-DRIFT', $2, NULL, $3, $3, 0, 'sent', '2026-05-01', 'k093')`,
      [COMPANY, OTHER_CUSTOMER, DRIFTED_TOTAL],
    );

    // A second drifted invoice, pointing at a DIFFERENT other-tenant customer.
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-DRIFT-2', $2, NULL, $3, $3, 0, 'sent', '2026-05-02', 'k093')`,
      [COMPANY, OTHER_CUSTOMER_2, DRIFTED_TOTAL_2],
    );

    // status explicitly NULL. `status != 'cancelled'` evaluates to NULL for this
    // row, so the bare inequality drops it — the same silent under-reporting
    // K-093 exists to fix, arriving through a different column.
    await admin.query(
      `INSERT INTO customers (id, company_id, name, is_active) VALUES ($2, $1, 'Null Status Customer', true)`,
      [COMPANY, CUSTOMER_NULL_STATUS],
    );
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-NULLSTATUS', $2, $2, $3, $3, 0, NULL, '2026-07-01', 'k093')`,
      [COMPANY, CUSTOMER_NULL_STATUS, NULL_STATUS_TOTAL],
    );

    // amount_paid NULL rather than 0. SUM() skips a NULL addend, so
    // `SUM(total_amount - amount_paid)` drops the whole invoice from
    // `outstanding` unless the column is COALESCEd inside the SUM.
    await admin.query(
      `INSERT INTO customer_invoices
         (company_id, invoice_number, customer_id, client_id, subtotal, total_amount,
          amount_paid, status, invoice_date, created_by)
       VALUES ($1, 'K093-NULLPAID', $2, $2, $3, $3, NULL, 'sent', '2026-06-01', 'k093')`,
      [COMPANY, CUSTOMER_MODERN, NULL_PAID_TOTAL],
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
    // The oracle reads the ledger with NO join to customers. Copying the
    // route's own join here would make the oracle exclude exactly what the
    // route excludes, and the two could never disagree.
    const { rows } = await admin.query(
      `SELECT COALESCE(SUM(ci.total_amount), 0)::numeric AS total, COUNT(*)::int AS n
         FROM customer_invoices ci
        -- COALESCE, not a bare inequality: an oracle that mirrors the route's
        -- own predicate can never disagree with it, and the route's bug WAS
        -- the predicate (NULL <> 'cancelled' is NULL, so the row vanishes).
        WHERE ci.company_id = $1 AND COALESCE(ci.status, '') <> 'cancelled'
          AND ci.invoice_date BETWEEN '2026-01-01' AND '2026-12-31'`,
      [COMPANY],
    );
    const ledgerTotal = Number(rows[0].total); // 1000+2500+700+3333+1111+1200+555
    const ledgerCount = Number(rows[0].n);     // 7

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

    // The report must foot to the ledger, including the drifted invoice whose
    // customer row belongs to another tenant — that row is unattributable, not
    // absent, and dropping it would under-report sales by its value.
    expect(reportInvoices).toBe(ledgerCount);
    expect(reportTotal).toBeCloseTo(ledgerTotal, 2);
    expect(data.map((r) => r.clientName).sort()).toEqual([
      'Boundary Customer', 'Legacy Customer', 'Modern Customer', 'Null Status Customer',
      `Unknown customer (${OTHER_CUSTOMER})`, `Unknown customer (${OTHER_CUSTOMER_2})`,
    ].sort());
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
    expect(reportTotal).toBeCloseTo(
      MODERN_TOTAL + LEGACY_TOTAL + BOUNDARY_TOTAL + DRIFTED_TOTAL + DRIFTED_TOTAL_2
      + NULL_PAID_TOTAL + NULL_STATUS_TOTAL, 2);
  });

  it('surfaces a drifted invoice as unattributed instead of dropping it', async () => {
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

    // The other tenant's customer NAME must never be printed on this report.
    expect(data.map((r) => r.clientName)).not.toContain('Other Tenant Customer');

    // But the invoice's own money must still be counted, under a placeholder.
    // Scoping the join by tenant without outer-joining would have turned a
    // mislabelled invoice into a silently omitted one — the same defect class
    // K-093 exists to fix.
    // Each unresolved id gets its OWN named placeholder row. Labelling both
    // 'Unknown customer' would print two identical rows carrying different
    // money, with nothing on the page or in the CSV to tell them apart.
    const unknown = data.find((r) => r.clientName === `Unknown customer (${OTHER_CUSTOMER})`);
    const unknown2 = data.find((r) => r.clientName === `Unknown customer (${OTHER_CUSTOMER_2})`);
    expect(unknown?.invoiceCount).toBe(1);
    expect(unknown?.totalSales).toBeCloseTo(DRIFTED_TOTAL, 2);
    expect(unknown2?.totalSales).toBeCloseTo(DRIFTED_TOTAL_2, 2);
    expect(unknown?.clientName).not.toBe(unknown2?.clientName);
  });

  it('reports an invoice whose status is NULL', async () => {
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
    const nullStatus = data.find((r) => r.clientName === 'Null Status Customer');

    // NULL is not 'cancelled'. A bare `status != 'cancelled'` returns NULL for
    // this row and WHERE drops it, under-reporting sales by its value.
    expect(nullStatus?.invoiceCount).toBe(1);
    expect(nullStatus?.totalSales).toBeCloseTo(NULL_STATUS_TOTAL, 2);
  });

  it('counts an invoice whose amount_paid is NULL towards outstanding', async () => {
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
    const modern = data.find((r) => r.clientName === 'Modern Customer');

    // Two invoices: R1,000 with amount_paid 0 and R1,200 with amount_paid NULL.
    // A bare `SUM(total_amount - amount_paid)` returns 1000, not 2200.
    expect(modern?.invoiceCount).toBe(2);
    expect(modern?.totalSales).toBeCloseTo(MODERN_TOTAL + NULL_PAID_TOTAL, 2);
    expect(modern?.outstanding).toBeCloseTo(MODERN_TOTAL + NULL_PAID_TOTAL, 2);
    expect(modern?.paymentsReceived).toBeCloseTo(0, 2);
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
    expect(csv).toContain('"Null Status Customer",1,555.00');
    // Two unattributable rows, each naming the id nobody could resolve.
    expect(csv).toContain(`"Unknown customer (${OTHER_CUSTOMER})",1,3333.00`);
    expect(csv).toContain(`"Unknown customer (${OTHER_CUSTOMER_2})",1,1111.00`);
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
