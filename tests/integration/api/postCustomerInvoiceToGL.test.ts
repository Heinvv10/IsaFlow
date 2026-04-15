/**
 * Integration test: BL-46 — postCustomerInvoiceToGL SELECT must be company_id-scoped
 *
 * Root cause: SELECT uses WHERE ci.id = ${invoiceId} with no tenant guard.
 * A caller passing another tenant's invoice ID corrupts both tenants' GL.
 *
 * Properties:
 *   A: postCustomerInvoiceToGL throws when invoice belongs to another tenant
 *   B: no journal entry is created in caller's GL
 *   C: the other tenant's invoice gl_journal_entry_id is unchanged
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';
import { postCustomerInvoiceToGL } from '@/modules/accounting/services/ar/customerPaymentAllocationService';

const COMPANY_A = '00000000-0000-0000-b146-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b146-000000000bb2';
const USER_ID   = '00000000-0000-0000-b146-000000000001';

let customerB: string;
let invoiceB: string;

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL46-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL46 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL46 Test Company B'),
  ]);

  const cust = await sql`
    INSERT INTO customers (name, company_id) VALUES ('BL46 Cust B', ${COMPANY_B}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  customerB = cust[0].id;

  const inv = await sql`
    INSERT INTO customer_invoices (
      company_id, invoice_number, customer_id, client_id,
      invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
      amount_paid, status, created_by
    ) VALUES (
      ${COMPANY_B}::UUID, 'BL46-INV-B', ${customerB}::UUID, ${customerB}::UUID,
      CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
      1000, 15, 150, 1150, 0, 'approved', ${USER_ID}
    ) RETURNING id
  ` as Array<{ id: string }>;
  invoiceB = inv[0].id;
});

afterAll(async () => {
  await sql`DELETE FROM gl_journal_lines WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM gl_journal_entries WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM customer_invoices WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM customers WHERE company_id IN (${COMPANY_B}::UUID)`;
  await sql`DELETE FROM companies WHERE id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
});

describe('BL-46: postCustomerInvoiceToGL SELECT is company_id-scoped', () => {
  it('A: throws when invoice belongs to another tenant', async () => {
    await expect(
      postCustomerInvoiceToGL(COMPANY_A, invoiceB, USER_ID)
    ).rejects.toThrow(/not found/i);
  });

  it('B: no journal entry created in caller tenant A', async () => {
    try { await postCustomerInvoiceToGL(COMPANY_A, invoiceB, USER_ID); } catch {}
    const rows = await sql`
      SELECT COUNT(*) AS cnt FROM gl_journal_entries WHERE company_id = ${COMPANY_A}::UUID
    ` as Array<{ cnt: string | number }>;
    expect(Number(rows[0].cnt)).toBe(0);
  });

  it('C: other-tenant invoice gl_journal_entry_id is still null', async () => {
    try { await postCustomerInvoiceToGL(COMPANY_A, invoiceB, USER_ID); } catch {}
    const rows = await sql`
      SELECT gl_journal_entry_id FROM customer_invoices WHERE id = ${invoiceB}::UUID
    ` as Array<{ gl_journal_entry_id: string | null }>;
    expect(rows[0].gl_journal_entry_id).toBeNull();
  });
});
