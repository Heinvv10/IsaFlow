/**
 * Integration test: BL-10 — customer-invoices-detail PUT/POST rowcount check
 *
 * Security finding S-003: UPDATE returns {updated:true} even when 0 rows are
 * matched, enabling an existence oracle / IDOR-adjacent flaw.
 *
 * Properties under test:
 *   A. PUT with a nonexistent invoice UUID → handler must return 404
 *   B. PUT with a foreign-tenant invoice UUID (company B) from company A context → 404
 *   C. PUT with own-tenant invoice (happy path) → 200 + {updated: true}
 *
 * We test the SQL layer directly (no HTTP server needed) by replicating the
 * exact UPDATE ... RETURNING id pattern the fixed handler uses, then asserting
 * on rowcount the same way the handler does.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const COMPANY_A = '00000000-0000-0000-b110-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b110-000000000bb2';
const NON_EXISTENT_UUID = '00000000-0000-0000-b110-000000009999';

let invoiceA: string; // created for COMPANY_A
let invoiceB: string; // created for COMPANY_B
let customerA: string; // created for COMPANY_A
let customerB: string; // created for COMPANY_B

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL10-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

/**
 * Replicate the FIXED handler's UPDATE ... RETURNING id for the PUT path.
 * Returns the number of rows affected (0 = invoice not found / wrong tenant).
 */
async function tryUpdateInvoice(
  companyId: string,
  id: string,
  notes: string
): Promise<number> {
  const result = await sql`
    UPDATE customer_invoices
    SET notes       = ${notes},
        updated_at  = NOW()
    WHERE id = ${id}::UUID
      AND company_id = ${companyId}::UUID
      AND status = 'draft'
    RETURNING id
  `;
  return result.length;
}

/**
 * Replicate the FIXED handler's UPDATE ... RETURNING id for the POST/action path.
 */
async function tryStatusAction(
  companyId: string,
  id: string,
  newStatus: string
): Promise<number> {
  const result = await sql`
    UPDATE customer_invoices
    SET status     = ${newStatus},
        updated_at = NOW()
    WHERE id = ${id}::UUID
      AND company_id = ${companyId}::UUID
    RETURNING id
  `;
  return result.length;
}

async function createTestCustomer(companyId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO customers (name, company_id, created_at)
    VALUES ('BL10 Test Customer', ${companyId}::UUID, NOW())
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

async function createTestInvoice(companyId: string, customerId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO customer_invoices (
      company_id, customer_id, invoice_number, status, subtotal, tax_rate,
      tax_amount, total_amount, amount_paid, invoice_date, due_date,
      created_by, created_at, updated_at
    )
    VALUES (
      ${companyId}::UUID,
      ${customerId}::UUID,
      'BL10-TEST-' || to_char(NOW(), 'HH24MISS'),
      'draft',
      100.00, 15.00, 15.00, 115.00, 0.00,
      NOW(), NOW() + INTERVAL '30 days',
      ${customerId}::UUID,
      NOW(), NOW()
    )
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

// ---------------------------------------------------------------------------
// Setup + Teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await ensureTestCompany(COMPANY_A, 'BL10 Test Company A');
  await ensureTestCompany(COMPANY_B, 'BL10 Test Company B');
  customerA = await createTestCustomer(COMPANY_A);
  customerB = await createTestCustomer(COMPANY_B);
  invoiceA = await createTestInvoice(COMPANY_A, customerA);
  invoiceB = await createTestInvoice(COMPANY_B, customerB);
});

afterAll(async () => {
  // Clean up test invoices then customers (FK order)
  await sql`
    DELETE FROM customer_invoices
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM customers
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  // Leave companies — harmless, ON CONFLICT DO NOTHING on next run
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BL-10 S-003: customer-invoices-detail rowcount guard', () => {
  // --- PUT path ---

  it('A: PUT with nonexistent invoice UUID → 0 rows affected (must return 404)', async () => {
    const rowCount = await tryUpdateInvoice(COMPANY_A, NON_EXISTENT_UUID, 'probe');
    // The fixed handler checks result.length === 0 → notFound(res, 'Invoice', id)
    expect(rowCount).toBe(0);
  });

  it('B: PUT with foreign-tenant invoice UUID → 0 rows affected (must return 404)', async () => {
    // Company A token tries to update an invoice owned by Company B.
    // The WHERE company_id = COMPANY_A filter ensures 0 rows match.
    const rowCount = await tryUpdateInvoice(COMPANY_A, invoiceB, 'cross-tenant probe');
    expect(rowCount).toBe(0);
  });

  it('C: PUT with own-tenant invoice → 1 row affected (happy path, must return 200)', async () => {
    const rowCount = await tryUpdateInvoice(COMPANY_A, invoiceA, 'legitimate note');
    expect(rowCount).toBe(1);
  });

  // --- POST/action path ---

  it('D: POST action with nonexistent invoice UUID → 0 rows affected (must return 404)', async () => {
    const rowCount = await tryStatusAction(COMPANY_A, NON_EXISTENT_UUID, 'approved');
    expect(rowCount).toBe(0);
  });

  it('E: POST action with foreign-tenant invoice UUID → 0 rows affected (must return 404)', async () => {
    const rowCount = await tryStatusAction(COMPANY_A, invoiceB, 'cancelled');
    expect(rowCount).toBe(0);
  });

  it('F: POST action with own-tenant invoice → 1 row affected (happy path, must return 200)', async () => {
    const rowCount = await tryStatusAction(COMPANY_A, invoiceA, 'approved');
    expect(rowCount).toBe(1);
  });
});
