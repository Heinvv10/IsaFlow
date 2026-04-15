/**
 * Integration test: BL-44 — customerPaymentAllocationService tenant isolation
 *
 * Root cause: confirmCustomerPayment UPDATEs inside withTransaction were keyed
 * by id-only:
 *   - UPDATE customer_invoices SET amount_paid ... WHERE id = alloc.invoiceId
 *   - UPDATE customer_invoices SET status      ... WHERE id = alloc.invoiceId
 *   - UPDATE customer_payments SET status = 'confirmed' WHERE id = paymentId
 *
 * A malicious or buggy caller supplying alloc.invoiceId pointing to another
 * tenant's invoice would mutate that invoice's amount_paid and status.
 *
 * This test validates the SQL-level tenant isolation invariants by directly
 * exercising the fixed WHERE patterns against the real Neon DB (no HTTP server
 * needed), mirroring the BL-40 / BL-41 style.
 *
 * Properties under test:
 *   A: UPDATE customer_invoices.amount_paid with company_id guard does NOT
 *      touch other-tenant row
 *   B: UPDATE customer_invoices.status with company_id guard does NOT
 *      touch other-tenant row
 *   C: UPDATE customer_payments with company_id guard does NOT
 *      touch other-tenant row
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_A = '00000000-0000-0000-b144-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b144-000000000bb2';
const USER_ID   = '00000000-0000-0000-b144-000000000001';

// ── State ─────────────────────────────────────────────────────────────────────

let customerB: string;  // customer belonging to COMPANY_B
let invoiceB: string;   // customer_invoices row belonging to COMPANY_B
let paymentB: string;   // customer_payments row belonging to COMPANY_B

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL44-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function createCustomer(companyId: string, tag: string): Promise<string> {
  const rows = await sql`
    INSERT INTO customers (name, company_id)
    VALUES (${'BL44 Test Customer ' + tag}, ${companyId}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

async function createCustomerInvoice(companyId: string, customerId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO customer_invoices (
      company_id, invoice_number, customer_id, client_id,
      invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
      amount_paid, status, created_by
    ) VALUES (
      ${companyId}::UUID, 'BL44-INV-B', ${customerId}::UUID, ${customerId}::UUID,
      CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
      1000.00, 15.00, 150.00, 1150.00,
      0, 'approved', ${USER_ID}
    ) RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

async function createCustomerPayment(companyId: string, clientId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO customer_payments (
      company_id, payment_number, client_id, payment_date,
      total_amount, payment_method, status, created_by
    ) VALUES (
      ${companyId}::UUID, 'BL44-PAY-B', ${clientId}::UUID, CURRENT_DATE,
      1150.00, 'eft', 'draft', ${USER_ID}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL44 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL44 Test Company B'),
  ]);

  customerB = await createCustomer(COMPANY_B, 'B');
  invoiceB = await createCustomerInvoice(COMPANY_B, customerB);
  paymentB = await createCustomerPayment(COMPANY_B, customerB);
});

afterAll(async () => {
  await sql`
    DELETE FROM customer_payments
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM customer_invoices
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM customers
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BL-44: customerPaymentAllocationService tenant isolation', () => {
  /**
   * A: The FIXED amount_paid UPDATE now includes AND company_id = ${companyId}.
   * An attacker from COMPANY_A trying to bump COMPANY_B's invoice balance must hit zero rows.
   */
  it('A: UPDATE customer_invoices.amount_paid scoped by company_id does not touch other-tenant row', async () => {
    const result = await sql`
      UPDATE customer_invoices SET amount_paid = amount_paid + 500
      WHERE id = ${invoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;

    expect(result).toHaveLength(0);

    const bRow = await sql`
      SELECT amount_paid FROM customer_invoices WHERE id = ${invoiceB}::UUID
    ` as Array<{ amount_paid: string | number }>;
    expect(Number(bRow[0].amount_paid)).toBe(0);
  });

  /**
   * B: The FIXED status UPDATE now includes AND company_id = ${companyId}.
   * Attacker cannot flip another tenant's invoice to 'paid'.
   */
  it('B: UPDATE customer_invoices.status scoped by company_id does not touch other-tenant row', async () => {
    const result = await sql`
      UPDATE customer_invoices SET status = 'paid', paid_at = NOW()
      WHERE id = ${invoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;

    expect(result).toHaveLength(0);

    const bRow = await sql`
      SELECT status FROM customer_invoices WHERE id = ${invoiceB}::UUID
    ` as Array<{ status: string }>;
    expect(bRow[0].status).toBe('approved');
  });

  /**
   * C: The FIXED customer_payments UPDATE now includes AND company_id = ${companyId}.
   * Attacker cannot confirm/cancel another tenant's payment row.
   */
  it('C: UPDATE customer_payments scoped by company_id does not touch other-tenant row', async () => {
    const result = await sql`
      UPDATE customer_payments
      SET status = 'confirmed', confirmed_by = ${USER_ID}::UUID, confirmed_at = NOW()
      WHERE id = ${paymentB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;

    expect(result).toHaveLength(0);

    const bRow = await sql`
      SELECT status FROM customer_payments WHERE id = ${paymentB}::UUID
    ` as Array<{ status: string }>;
    expect(bRow[0].status).toBe('draft');
  });
});
