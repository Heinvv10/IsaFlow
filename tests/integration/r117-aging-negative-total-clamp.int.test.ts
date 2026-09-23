/**
 * R-117 — `effectivePaidExpr` clamps the settled amount into [0, total_amount]
 * one-sidedly. On a NEGATIVE-total document (total -1150, amount_paid 0) that
 * reads `LEAST(GREATEST(0, 0), -1150)` = -1150: the report says R1,150 was
 * settled on a document nobody paid, and the balance computes to exactly zero.
 *
 * Negative totals are reachable today — no CHECK constraint on either table,
 * and several writers (recurring-template execution, the AI capture pipeline,
 * time-entry billing, the Sage AR import) apply no sign guard. The writers are
 * a separate finding; this one is the clamp.
 *
 * The customer and supplier reports SUM the expression with no balance filter,
 * so they are where the mis-statement surfaces. The ageing and the subledger
 * both filter `balance > 0`, which excludes a negative document either way.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { getCustomerReport, getSupplierReport } from '@/modules/accounting/services/reports/transactionReportingService';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const COMPANY = randomUUID();
const USER = randomUUID();
const PERIOD_START = '2026-06-01';
const PERIOD_END = '2026-06-30';

let customerId: string;
let supplierId: string;

describeIfDb('R-117 a negative-total document reports nothing settled, not its own total', () => {
  beforeAll(async () => {
    await sql`
      INSERT INTO companies (id, name, registration_number, created_at)
      VALUES (${COMPANY}::UUID, ${'R117 ' + COMPANY.slice(0, 8)}, 'R117-TEST', NOW())`;
    customerId = ((await sql`
      INSERT INTO customers (name, company_id) VALUES ('R117 Customer', ${COMPANY}::UUID) RETURNING id
    `) as { id: string }[])[0]!.id;
    supplierId = ((await sql`
      INSERT INTO suppliers (name, company_id) VALUES ('R117 Supplier', ${COMPANY}::UUID) RETURNING id
    `) as { id: string }[])[0]!.id;

    // Nobody has paid either document: amount_paid 0 on a negative total.
    await sql`
      INSERT INTO customer_invoices (
        company_id, invoice_number, customer_id, client_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES (
        ${COMPANY}::UUID, 'R117-CI-1', ${customerId}::UUID, ${customerId}::UUID,
        ${PERIOD_END}::DATE, ${PERIOD_END}::DATE,
        -1000.00, 15.00, -150.00, -1150.00, 0, 'sent', ${USER}::UUID
      )`;
    await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id, invoice_date, due_date,
        subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
      ) VALUES (
        ${COMPANY}::UUID, 'R117-SI-1', ${supplierId}::UUID,
        ${PERIOD_END}::DATE, ${PERIOD_END}::DATE,
        -1000.00, 15.00, -150.00, -1150.00, 0, 'approved', ${USER}::UUID
      )`;
  });

  afterAll(async () => {
    await sql`DELETE FROM customer_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM supplier_invoices WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM customers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM suppliers WHERE company_id = ${COMPANY}::UUID`;
    await sql`DELETE FROM companies WHERE id = ${COMPANY}::UUID`;
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

  it('a settlement against a negative document is kept, not clamped away', async () => {
    // A refund of 500 against the -1150 credit: 500 of it is settled.
    await sql`
      UPDATE customer_invoices SET amount_paid = -500
      WHERE company_id = ${COMPANY}::UUID AND invoice_number = 'R117-CI-1'`;
    const rows = await getCustomerReport(COMPANY, PERIOD_START, PERIOD_END);
    const row = rows.find((r) => r.clientId === customerId);
    expect(Number(row!.totalPaid)).toBe(-500);
    await sql`
      UPDATE customer_invoices SET amount_paid = 0
      WHERE company_id = ${COMPANY}::UUID AND invoice_number = 'R117-CI-1'`;
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
});
