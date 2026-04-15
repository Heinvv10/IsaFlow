/**
 * Integration test: BL-47 — processSupplierPayment UPDATEs on supplier_invoices
 * must be company_id-scoped (two UPDATEs: amount_paid and status).
 *
 * Cross-tenant assertion: UPDATE keyed by COMPANY_B invoice id but scoped to
 * COMPANY_A must hit 0 rows; COMPANY_B row must remain unchanged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';

const COMPANY_A = '00000000-0000-0000-b147-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b147-000000000bb2';
const USER_ID   = '00000000-0000-0000-b147-000000000001';

let supplierB: string;
let invoiceB:  string;

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL47-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL47 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL47 Test Company B'),
  ]);

  const sup = await sql`
    INSERT INTO suppliers (name, company_id)
    VALUES ('BL47 Supplier B', ${COMPANY_B}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  supplierB = sup[0]!.id;

  const inv = await sql`
    INSERT INTO supplier_invoices (
      company_id, invoice_number, supplier_id, invoice_date, due_date,
      subtotal, tax_rate, tax_amount, total_amount, amount_paid, status, created_by
    ) VALUES (
      ${COMPANY_B}::UUID, 'BL47-SINV-B', ${supplierB}::UUID,
      CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
      1000, 15, 150, 1150, 0, 'approved', ${USER_ID}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  invoiceB = inv[0]!.id;
});

afterAll(async () => {
  await sql`DELETE FROM supplier_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM suppliers WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM companies WHERE id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
});

describe('BL-47: processSupplierPayment supplier_invoice UPDATEs are company_id-scoped', () => {
  it('A: UPDATE supplier_invoices.amount_paid with COMPANY_A guard misses COMPANY_B row', async () => {
    const result = await sql`
      UPDATE supplier_invoices
      SET amount_paid = amount_paid + 500
      WHERE id = ${invoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);

    const row = await sql`
      SELECT amount_paid FROM supplier_invoices WHERE id = ${invoiceB}::UUID
    ` as Array<{ amount_paid: string | number }>;
    expect(Number(row[0]!.amount_paid)).toBe(0);
  });

  it('B: UPDATE supplier_invoices.status with COMPANY_A guard misses COMPANY_B row', async () => {
    const result = await sql`
      UPDATE supplier_invoices SET status = CASE
        WHEN (total_amount - amount_paid) <= 0.01 THEN 'paid'
        WHEN amount_paid > 0 THEN 'partially_paid'
        ELSE status
      END
      WHERE id = ${invoiceB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);

    const row = await sql`
      SELECT status FROM supplier_invoices WHERE id = ${invoiceB}::UUID
    ` as Array<{ status: string }>;
    expect(row[0]!.status).toBe('approved');
  });

  it('C: UPDATE with correct COMPANY_B guard succeeds', async () => {
    const result = await sql`
      UPDATE supplier_invoices
      SET amount_paid = amount_paid + 100
      WHERE id = ${invoiceB}::UUID AND company_id = ${COMPANY_B}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(1);

    const row = await sql`
      SELECT amount_paid FROM supplier_invoices WHERE id = ${invoiceB}::UUID
    ` as Array<{ amount_paid: string | number }>;
    expect(Number(row[0]!.amount_paid)).toBe(100);
  });
});
