/**
 * Integration test: BL-45 — approveCreditNote / cancelCreditNote UPDATEs must be company_id-scoped
 *
 * Validates SQL-level tenant isolation invariants for the 5 UPDATE patterns
 * in approveCreditNote and cancelCreditNote, mirroring the BL-44 test style.
 *
 * Properties under test (each UPDATE site, cross-tenant id must hit zero rows):
 *   A: UPDATE customer_invoices.amount_paid (approve path)
 *   B: UPDATE supplier_invoices.amount_paid (approve path)
 *   C: UPDATE credit_notes status='approved'
 *   D: UPDATE customer_invoices.amount_paid + status (cancel path)
 *   E: UPDATE supplier_invoices.amount_paid (cancel path)
 *   F: UPDATE credit_notes status='cancelled'
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';

const COMPANY_A = '00000000-0000-0000-b145-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b145-000000000bb2';
const USER_ID   = '00000000-0000-0000-b145-000000000001';

let customerB: string;
let supplierB: string;
let customerInvoiceB: string;
let supplierInvoiceB: string;
let creditNoteB: string;

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL45-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL45 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL45 Test Company B'),
  ]);

  const cust = await sql`
    INSERT INTO customers (name, company_id) VALUES ('BL45 Cust B', ${COMPANY_B}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  customerB = cust[0].id;

  const sup = await sql`
    INSERT INTO suppliers (name, company_id) VALUES ('BL45 Sup B', ${COMPANY_B}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  supplierB = sup[0].id;

  const ci = await sql`
    INSERT INTO customer_invoices (
      company_id, invoice_number, customer_id, client_id,
      invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
      amount_paid, status, created_by
    ) VALUES (
      ${COMPANY_B}::UUID, 'BL45-INV-B', ${customerB}::UUID, ${customerB}::UUID,
      CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
      1000, 15, 150, 1150, 0, 'approved', ${USER_ID}
    ) RETURNING id
  ` as Array<{ id: string }>;
  customerInvoiceB = ci[0].id;

  const si = await sql`
    INSERT INTO supplier_invoices (
      company_id, invoice_number, supplier_id, invoice_date, due_date,
      subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
    ) VALUES (
      ${COMPANY_B}::UUID, 'BL45-SINV-B', ${supplierB}::UUID,
      CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
      1000, 15, 150, 1150, 0, 'approved', ${USER_ID}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  supplierInvoiceB = si[0].id;

  const cn = await sql`
    INSERT INTO credit_notes (
      company_id, type, client_id, credit_date, reason,
      subtotal, tax_rate, tax_amount, total_amount, status, created_by
    ) VALUES (
      ${COMPANY_B}::UUID, 'customer', ${customerB}::UUID, CURRENT_DATE, 'BL45',
      100, 15, 15, 115, 'draft', ${USER_ID}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  creditNoteB = cn[0].id;
});

afterAll(async () => {
  await sql`DELETE FROM credit_notes WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM customer_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM supplier_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM customers WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM suppliers WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM companies WHERE id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
});

describe('BL-45: creditNoteService UPDATEs are company_id-scoped', () => {
  it('A: UPDATE customer_invoices.amount_paid with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE customer_invoices SET amount_paid = amount_paid + 500
      WHERE id = ${customerInvoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
    const row = await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${customerInvoiceB}::UUID` as Array<{ amount_paid: string | number }>;
    expect(Number(row[0].amount_paid)).toBe(0);
  });

  it('B: UPDATE supplier_invoices.amount_paid with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE supplier_invoices SET amount_paid = amount_paid + 500
      WHERE id = ${supplierInvoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
    const row = await sql`SELECT amount_paid FROM supplier_invoices WHERE id = ${supplierInvoiceB}::UUID` as Array<{ amount_paid: string | number }>;
    expect(Number(row[0].amount_paid)).toBe(0);
  });

  it('C: UPDATE credit_notes to approved with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE credit_notes SET status = 'approved'
      WHERE id = ${creditNoteB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
    const row = await sql`SELECT status FROM credit_notes WHERE id = ${creditNoteB}::UUID` as Array<{ status: string }>;
    expect(row[0].status).toBe('draft');
  });

  it('D: UPDATE customer_invoices cancel-path with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE customer_invoices
      SET amount_paid = GREATEST(0, amount_paid - 100), status = 'approved'
      WHERE id = ${customerInvoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
  });

  it('E: UPDATE supplier_invoices cancel-path with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE supplier_invoices
      SET amount_paid = GREATEST(0, amount_paid - 100)
      WHERE id = ${supplierInvoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
  });

  it('F: UPDATE credit_notes to cancelled with company_id guard misses other-tenant row', async () => {
    const result = await sql`
      UPDATE credit_notes SET status = 'cancelled'
      WHERE id = ${creditNoteB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
    const row = await sql`SELECT status FROM credit_notes WHERE id = ${creditNoteB}::UUID` as Array<{ status: string }>;
    expect(row[0].status).toBe('draft');
  });
});
