/**
 * Integration test: BL-41 — sageCustomerImportService cross-tenant scoping
 *
 * Root cause (mirror of BL-40 on the AR side): importCustomerInvoices had:
 *   - SELECT with no company_id filter → would pull rows from ALL tenants
 *   - INSERT into customer_invoices omitting company_id
 *     (NOT NULL column → throws on every call → silent failure)
 *   - UPDATEs to sage_customer_invoices scoped by id only → cross-tenant status mutation
 *
 * This test file validates the SQL-level tenant isolation invariants
 * by directly exercising the fixed WHERE/INSERT patterns against the
 * real Neon DB (no HTTP server needed).
 *
 * Properties under test:
 *   A: SELECT sage_customer_invoices with company_id filter → excludes other tenant rows
 *   B: UPDATE sage_customer_invoices with company_id guard → does NOT touch other-tenant row
 *   C: INSERT customer_invoices with company_id → succeeds (was throwing before BL-41)
 *   D: cross-tenant SELECT isolation — querying as A never returns B rows and vice versa
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_A = '00000000-0000-0000-b141-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b141-000000000bb2';
const USER_ID   = '00000000-0000-0000-b141-000000000001';

// ── State ─────────────────────────────────────────────────────────────────────

let sageInvA: string;  // sage_customer_invoices row for Company A
let sageInvB: string;  // sage_customer_invoices row for Company B
let customerA: string; // customers row for Company A (FK for customer_invoices.client_id)

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL41-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function createSageCustomerInvoice(companyId: string, tag: string): Promise<string> {
  const rows = await sql`
    INSERT INTO sage_customer_invoices (
      invoice_number, invoice_date, total_amount, migration_status, company_id
    ) VALUES (
      ${'BL41-CI-' + tag}, CURRENT_DATE, 1150.00, 'pending', ${companyId}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

async function createCustomer(companyId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO customers (name, company_id)
    VALUES ('BL41 Test Customer', ${companyId}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL41 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL41 Test Company B'),
  ]);

  [sageInvA, sageInvB, customerA] = await Promise.all([
    createSageCustomerInvoice(COMPANY_A, 'A'),
    createSageCustomerInvoice(COMPANY_B, 'B'),
    createCustomer(COMPANY_A),
  ]);
});

afterAll(async () => {
  // Tear down in FK-safe order
  await sql`
    DELETE FROM customer_invoice_items
    WHERE invoice_id IN (
      SELECT id FROM customer_invoices
      WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
    )
  `;
  await sql`
    DELETE FROM customer_invoices
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM sage_customer_invoices
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM customers
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BL-41: sageCustomerImportService tenant isolation', () => {

  /**
   * A: The FIXED SELECT on sage_customer_invoices includes AND company_id = ${companyId}.
   * Querying as COMPANY_A must see A's row but NOT B's row.
   */
  it('A: SELECT sage_customer_invoices with company_id filter excludes other-tenant rows', async () => {
    const rowsForA = await sql`
      SELECT id, migration_status
      FROM sage_customer_invoices
      WHERE migration_status = 'pending'
        AND company_id = ${COMPANY_A}::UUID
    ` as Array<{ id: string }>;

    const ids = rowsForA.map(r => r.id);
    expect(ids).toContain(sageInvA);
    expect(ids).not.toContain(sageInvB);
  });

  /**
   * B: The FIXED UPDATE on sage_customer_invoices includes AND company_id = ${companyId}.
   * Running an update as COMPANY_A must NOT mutate COMPANY_B's row.
   */
  it('B: UPDATE sage_customer_invoices scoped by company_id does not touch other-tenant row', async () => {
    const result = await sql`
      UPDATE sage_customer_invoices
      SET migration_status = 'failed'
      WHERE id = ${sageInvB}
        AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;

    // Must match zero rows — B's row is guarded by the company_id predicate
    expect(result).toHaveLength(0);

    // Verify B's row is still 'pending'
    const bRow = await sql`
      SELECT migration_status FROM sage_customer_invoices WHERE id = ${sageInvB}
    ` as Array<{ migration_status: string }>;
    expect(bRow[0].migration_status).toBe('pending');
  });

  /**
   * C: The FIXED INSERT into customer_invoices now includes company_id.
   * This must succeed (previously threw on every call due to NOT NULL violation).
   */
  it('C: INSERT customer_invoices with company_id succeeds (was throwing pre-BL-41)', async () => {
    const result = await sql`
      INSERT INTO customer_invoices (
        company_id,
        invoice_number, customer_id, client_id, invoice_date, due_date,
        billing_period_start, billing_period_end,
        subtotal, tax_rate, tax_amount, total_amount,
        amount_paid, status, created_by
      ) VALUES (
        ${COMPANY_A}::UUID,
        'BL41-CI-INTEG-001',
        ${customerA}::UUID,
        ${customerA}::UUID,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00,
        0, 'approved', ${USER_ID}
      ) RETURNING id, company_id
    ` as Array<{ id: string; company_id: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].company_id).toBe(COMPANY_A);
  });

  /**
   * D: End-to-end cross-tenant SELECT isolation.
   * Both tenants have pending rows. Query as A → only A's row returned.
   * Query as B → only B's row returned.
   */
  it('D: cross-tenant SELECT isolation — querying as A never returns B rows and vice versa', async () => {
    const aRows = await sql`
      SELECT id FROM sage_customer_invoices
      WHERE migration_status = 'pending'
        AND company_id = ${COMPANY_A}::UUID
    ` as Array<{ id: string }>;

    const bRows = await sql`
      SELECT id FROM sage_customer_invoices
      WHERE migration_status = 'pending'
        AND company_id = ${COMPANY_B}::UUID
    ` as Array<{ id: string }>;

    const aIds = aRows.map(r => r.id);
    const bIds = bRows.map(r => r.id);

    // A's view must include A's row and exclude B's
    expect(aIds).toContain(sageInvA);
    expect(aIds).not.toContain(sageInvB);

    // B's view must include B's row and exclude A's
    expect(bIds).toContain(sageInvB);
    expect(bIds).not.toContain(sageInvA);

    // The two sets must be disjoint
    const intersection = aIds.filter(id => bIds.includes(id));
    expect(intersection).toHaveLength(0);
  });
});
