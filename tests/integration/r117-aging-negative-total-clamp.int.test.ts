/**
 * R-117 — `effectivePaidExpr` clamps the settled amount into [0, total_amount]
 * one-sidedly. On a NEGATIVE-total document (total -1150, amount_paid 0) that
 * reads `LEAST(GREATEST(0, 0), -1150)` = -1150: the report says R1,150 was
 * settled on a document nobody paid, and the balance computes to exactly zero.
 *
 * Negative totals are in production today. Migration 692 (R-119) now refuses
 * NEW ones, so these fixtures are written through `insertPreConstraintRow`,
 * which suppresses the guard for one transaction — the same way migration
 * 664's rows are seeded. The rows this clamp serves are exactly the ones
 * written before that guard existed.
 *
 * Four sites SUM the expression with NO balance filter, and they are where the
 * mis-statement surfaces: `transactionReportingService`'s customer and supplier
 * reports, and the `sales-by-customer` / `purchases-by-supplier` routes
 * (Received and Outstanding). The ageing and the subledger filter
 * `balance > 0`, which excludes a negative document either way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { insertPreConstraintRow } from './helpers/preConstraintRow';
import { getCustomerReport, getSupplierReport } from '@/modules/accounting/services/reports/transactionReportingService';
import { SignJWT } from 'jose';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import salesByCustomer from '../../pages/api/accounting/reports/sales-by-customer';
import purchasesBySupplier from '../../pages/api/accounting/reports/purchases-by-supplier';

assertDisposable();

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const PERIOD_START = '2026-06-01';
const PERIOD_END = '2026-06-30';

let pool: Pool;
let customerId: string;
let supplierId: string;

/** A negative-total document: migration 692 refuses these, so bypass it. */
async function seedNegative(table: 'customer_invoices' | 'supplier_invoices', text: string, values: unknown[]) {
  await insertPreConstraintRow(pool, text, values);
}

describeIfDb('R-117 a negative-total document reports nothing settled, not its own total', () => {
  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'R117 ' + COMPANY.slice(0, 8)}, 'R117-TEST', NOW())`;
    await sql`
      INSERT INTO users (id, email, role, is_active)
      VALUES (${USER}, ${'r117-' + USER + '@isaflow.test'}, 'admin', true)`;
    await sql`
      INSERT INTO company_users (company_id, user_id, role)
      VALUES (${COMPANY}::UUID, ${USER}, 'admin')`;
    customerId = ((await sql`
      INSERT INTO customers (name, company_id) VALUES ('R117 Customer', ${COMPANY}::UUID) RETURNING id
    `) as { id: string }[])[0]!.id;
    supplierId = ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R117 Supplier', ${COMPANY}::UUID) RETURNING id
    `) as { id: string }[])[0]!.id;

    // Nobody has paid either document: amount_paid 0 on a negative total.
    await seedNegative('customer_invoices', `
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES ($1::UUID, 'R117-CI-1', $2::UUID, $2::UUID, $3::DATE, $3::DATE,
        -1000.00, 15.00, -150.00, -1150.00, 0, 'sent', $4)`,
      [COMPANY, customerId, PERIOD_END, USER]);
    await seedNegative('supplier_invoices', `
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES ($1::UUID, 'R117-SI-1', $2::UUID, $3::DATE, $3::DATE,
        -1000.00, 15.00, -150.00, -1150.00, 0, 'approved', $4)`,
      [COMPANY, supplierId, PERIOD_END, USER]);
  });

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM company_users WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
    // users.id is VARCHAR, not UUID — casting the column's side raises 42883.
    await sql`DELETE FROM users WHERE id = ${USER}`;
    await pool.end();
  }, 60000);

  it('the customer report shows nothing paid on an unpaid negative-total invoice', async () => {
    const rows = await getCustomerReport(COMPANY, PERIOD_START, PERIOD_END);
    const row = rows.find((r) => r.clientId === customerId);
    expect(row).toBeDefined();
    expect(Number(row!.totalInvoiced)).toBe(-1150);
    // The defect reported -1150 "paid", which also made outstanding look like 0.
    expect(Number(row!.totalPaid)).toBe(0);
    expect(Number(row!.totalInvoiced) - Number(row!.totalPaid)).toBe(-1150);
  });

  it('the supplier report shows nothing paid on an unpaid negative-total bill', async () => {
    const rows = await getSupplierReport(COMPANY, PERIOD_START, PERIOD_END);
    const row = rows.find((r) => r.supplierId === supplierId);
    expect(row).toBeDefined();
    expect(Number(row!.totalInvoiced)).toBe(-1150);
    expect(Number(row!.totalPaid)).toBe(0);
  });

  it.each([
    // [amount_paid on a -1150 document, what the report must say was settled]
    [-500, -500],    // a partial refund: kept, not clamped away
    [-1150, -1150],  // settled in full
    [-2000, -1150],  // over-settled: bounded by the document's own total
    [500, 0],        // wrong-signed: outside [total, 0], so nothing is settled
  ])('amount_paid %s on a -1150 document reports %s settled', async (paid, expected) => {
    // Its own document, so the case cannot depend on another case restoring
    // state — and its own customer, so the report row is only this document.
    const isolated = ((await sql`
      INSERT INTO customers (name, company_id) VALUES (${'R117 iso ' + paid}, ${COMPANY}::UUID)
      RETURNING id`) as { id: string }[])[0]!.id;
    await seedNegative('customer_invoices', `
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES ($1::UUID, $2, $3::UUID, $3::UUID, $4::DATE, $4::DATE,
        -1000.00, 15.00, -150.00, -1150.00, $5, 'sent', $6)`,
      [COMPANY, `R117-ISO-${paid}`, isolated, PERIOD_END, paid, USER]);
    const rows = await getCustomerReport(COMPANY, PERIOD_START, PERIOD_END);
    const row = rows.find((r) => r.clientId === isolated);
    expect(Number(row!.totalPaid)).toBe(expected);
  });

  it('a positive document is unaffected: an overpayment still clamps to the total', async () => {
    await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES (
        ${COMPANY}::UUID, 'R117-CI-2', ${customerId}::UUID, ${customerId}::UUID,
        ${PERIOD_END}::DATE, ${PERIOD_END}::DATE,
        1000.00, 15.00, 150.00, 1150.00, 1200.00, 'sent', ${USER}::UUID
      )`;
    const rows = await getCustomerReport(COMPANY, PERIOD_START, PERIOD_END);
    const row = rows.find((r) => r.clientId === customerId);
    // -1150 + 1150 invoiced; paid 0 on the credit and 1150 (not 1200) on the invoice.
    expect(Number(row!.totalInvoiced)).toBe(0);
    expect(Number(row!.totalPaid)).toBe(1150);
    await sql`
      DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID AND invoice_number = 'R117-CI-2'`;
  });

  /** Drive a report route through withAuth, as the page does. */
  async function callReport(
    handler: (req: never, res: never) => unknown, url: string,
  ): Promise<Array<Record<string, unknown>>> {
    const token = await new SignJWT({ sub: USER, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    const req = request({ 'sb-access-token': token, active_company_id: COMPANY }, 'GET') as never as
      { query: Record<string, string>; url: string };
    req.query = { from: PERIOD_START, to: PERIOD_END };
    req.url = url;
    const out = response();
    await handler(req as never, out.res as never);
    expect(out.state.statusCode).toBe(200);
    return (out.state.body as { data?: Array<Record<string, unknown>> }).data ?? [];
  }

  it('sales-by-customer reports nothing received on the unpaid credit', async () => {
    // The route SUMs the same expression with no balance filter; its Received
    // and Outstanding columns move with this change and nothing covered them.
    const rows = await callReport(salesByCustomer, '/api/accounting/reports/sales-by-customer');
    const row = rows.find((r) => String(r.clientId) === customerId);
    expect(row).toBeDefined();
    expect(Number(row!.totalSales)).toBe(-1150);
    expect(Number(row!.paymentsReceived)).toBe(0);
    expect(Number(row!.outstanding)).toBe(-1150);
  });

  it('purchases-by-supplier reports nothing paid on the unpaid credit', async () => {
    // The AP twin of the same unfiltered SUM: its SQL is a copy, so it needs
    // its own assertion or a divergence in that one file goes unnoticed.
    const rows = await callReport(purchasesBySupplier, '/api/accounting/reports/purchases-by-supplier');
    const row = rows.find((r) => String(r.supplierId) === supplierId);
    expect(row).toBeDefined();
    expect(Number(row!.totalPurchases)).toBe(-1150);
    expect(Number(row!.paymentsMade)).toBe(0);
    expect(Number(row!.outstanding)).toBe(-1150);
  });
});
