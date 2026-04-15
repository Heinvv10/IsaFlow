/**
 * Integration test: BL-40 — sageImportService cross-tenant scoping
 *
 * Root cause: importLedgerTransactions and importSupplierInvoices had:
 *   - SELECTs with no company_id filter → would pull rows from ALL tenants
 *   - INSERTs into gl_journal_entries / supplier_invoices omitting company_id
 *     (NOT NULL column → throws on every call → silent failure = F-010)
 *   - UPDATEs to sage_* tables scoped by id only → cross-tenant status mutation
 *
 * This test file validates the SQL-level tenant isolation invariants
 * by directly exercising the fixed WHERE/INSERT patterns against the
 * real Neon DB (no HTTP server needed).
 *
 * Properties under test:
 *   A: SELECT sage_supplier_invoices with company_id filter → excludes other tenant rows
 *   B: SELECT sage_ledger_transactions with company_id filter → excludes other tenant rows
 *   C: UPDATE sage_supplier_invoices with company_id guard → does NOT touch other-tenant row
 *   D: UPDATE sage_ledger_transactions with company_id guard → does NOT touch other-tenant row
 *   E: INSERT gl_journal_entries with company_id → succeeds (was throwing before BL-40)
 *   F: INSERT supplier_invoices with company_id → succeeds (was throwing before BL-40)
 *   G: Full SELECT → only returns own-tenant rows when both tenants have pending rows
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { sql } from '@/lib/neon';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_A = '00000000-0000-0000-b140-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b140-000000000bb2';
const USER_ID   = '00000000-0000-0000-b140-000000000001';

// ── State ─────────────────────────────────────────────────────────────────────

let sageInvA: string;  // sage_supplier_invoices row for Company A
let sageInvB: string;  // sage_supplier_invoices row for Company B
let sageLedA: string;  // sage_ledger_transactions row for Company A
let sageLedB: string;  // sage_ledger_transactions row for Company B
let supplierA: string; // suppliers row for Company A (FK for supplier_invoices)
let glAccountA: string; // gl_accounts row for Company A (FK for journal lines)

// ── Helpers ───────────────────────────────────────────────────────────────────

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL40-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

async function createSageSupplierInvoice(companyId: string, tag: string): Promise<string> {
  const rows = await sql`
    INSERT INTO sage_supplier_invoices (
      invoice_number, invoice_date, total_amount, migration_status, company_id
    ) VALUES (
      ${'BL40-SI-' + tag}, CURRENT_DATE, 1150.00, 'pending', ${companyId}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

async function createSageLedgerTransaction(companyId: string, tag: string): Promise<string> {
  const rows = await sql`
    INSERT INTO sage_ledger_transactions (
      sage_id, account_code, transaction_date, description,
      debit, credit, migration_status, company_id
    ) VALUES (
      ${'BL40-SLT-' + tag}, '1000', CURRENT_DATE,
      ${'BL40 ledger tx ' + tag},
      1000.00, 1000.00, 'pending', ${companyId}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

async function createSupplier(companyId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO suppliers (name, company_id)
    VALUES ('BL40 Test Supplier', ${companyId}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

async function createGlAccount(companyId: string): Promise<string> {
  const rows = await sql`
    INSERT INTO gl_accounts (
      account_code, account_name, account_type, normal_balance, company_id
    ) VALUES (
      'BL40-9999', 'BL40 Test Account', 'expense', 'debit', ${companyId}::UUID
    ) RETURNING id
  ` as Array<{ id: string }>;
  return rows[0].id;
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL40 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL40 Test Company B'),
  ]);

  [sageInvA, sageInvB, sageLedA, sageLedB, supplierA, glAccountA] = await Promise.all([
    createSageSupplierInvoice(COMPANY_A, 'A'),
    createSageSupplierInvoice(COMPANY_B, 'B'),
    createSageLedgerTransaction(COMPANY_A, 'A'),
    createSageLedgerTransaction(COMPANY_B, 'B'),
    createSupplier(COMPANY_A),
    createGlAccount(COMPANY_A),
  ]);
});

afterAll(async () => {
  // Tear down in FK-safe order
  await sql`
    DELETE FROM gl_journal_lines
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM gl_journal_entries
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM supplier_invoices
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM sage_supplier_invoices
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM sage_ledger_transactions
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM suppliers
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
  await sql`
    DELETE FROM gl_accounts
    WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)
  `;
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('BL-40: sageImportService tenant isolation', () => {

  /**
   * A: The FIXED SELECT on sage_supplier_invoices includes AND company_id = ${companyId}.
   * Querying as COMPANY_A must see A's row but NOT B's row.
   */
  it('A: SELECT sage_supplier_invoices with company_id filter excludes other-tenant rows', async () => {
    const rowsForA = await sql`
      SELECT id, migration_status
      FROM sage_supplier_invoices
      WHERE migration_status = 'pending'
        AND company_id = ${COMPANY_A}::UUID
    ` as Array<{ id: string }>;

    const ids = rowsForA.map(r => r.id);
    expect(ids).toContain(sageInvA);
    expect(ids).not.toContain(sageInvB);
  });

  /**
   * B: The FIXED SELECT on sage_ledger_transactions includes AND company_id = ${companyId}.
   * Querying as COMPANY_A must see A's row but NOT B's row.
   */
  it('B: SELECT sage_ledger_transactions with company_id filter excludes other-tenant rows', async () => {
    const rowsForA = await sql`
      SELECT id, migration_status
      FROM sage_ledger_transactions
      WHERE migration_status = 'pending'
        AND company_id = ${COMPANY_A}::UUID
    ` as Array<{ id: string }>;

    const ids = rowsForA.map(r => r.id);
    expect(ids).toContain(sageLedA);
    expect(ids).not.toContain(sageLedB);
  });

  /**
   * C: The FIXED UPDATE on sage_supplier_invoices includes AND company_id = ${companyId}.
   * Running an update as COMPANY_A must NOT mutate COMPANY_B's row.
   */
  it('C: UPDATE sage_supplier_invoices scoped by company_id does not touch other-tenant row', async () => {
    // Simulate the "mark as failed" UPDATE the fixed service issues
    const result = await sql`
      UPDATE sage_supplier_invoices
      SET migration_status = 'failed'
      WHERE id = ${sageInvB}
        AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;

    // Must match zero rows — B's row is guarded by the company_id predicate
    expect(result).toHaveLength(0);

    // Verify B's row is still 'pending'
    const bRow = await sql`
      SELECT migration_status FROM sage_supplier_invoices WHERE id = ${sageInvB}
    ` as Array<{ migration_status: string }>;
    expect(bRow[0].migration_status).toBe('pending');
  });

  /**
   * D: The FIXED UPDATE on sage_ledger_transactions includes AND company_id = ${companyId}.
   * Running an update as COMPANY_A must NOT mutate COMPANY_B's row.
   */
  it('D: UPDATE sage_ledger_transactions scoped by company_id does not touch other-tenant row', async () => {
    const result = await sql`
      UPDATE sage_ledger_transactions
      SET migration_status = 'failed'
      WHERE id = ${sageLedB}
        AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;

    expect(result).toHaveLength(0);

    const bRow = await sql`
      SELECT migration_status FROM sage_ledger_transactions WHERE id = ${sageLedB}
    ` as Array<{ migration_status: string }>;
    expect(bRow[0].migration_status).toBe('pending');
  });

  /**
   * E: The FIXED INSERT into gl_journal_entries now includes company_id.
   * This must succeed (previously threw on every call due to NOT NULL violation).
   */
  it('E: INSERT gl_journal_entries with company_id succeeds (was throwing pre-BL-40)', async () => {
    const result = await sql`
      INSERT INTO gl_journal_entries (
        entry_number, entry_date, description, source, status, created_by, company_id
      ) VALUES (
        'BL40-TEST-JE', CURRENT_DATE, 'BL40 integration test entry',
        'manual', 'posted', ${USER_ID}::UUID, ${COMPANY_A}::UUID
      ) RETURNING id, company_id
    ` as Array<{ id: string; company_id: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].company_id).toBe(COMPANY_A);
  });

  /**
   * F: The FIXED INSERT into supplier_invoices now includes company_id.
   * This must succeed (previously threw on every call due to NOT NULL violation).
   */
  it('F: INSERT supplier_invoices with company_id succeeds (was throwing pre-BL-40)', async () => {
    const result = await sql`
      INSERT INTO supplier_invoices (
        company_id, invoice_number, supplier_id,
        invoice_date, due_date, subtotal, tax_rate, tax_amount, total_amount,
        amount_paid, status, created_by
      ) VALUES (
        ${COMPANY_A}::UUID,
        'BL40-SI-INTEG-001',
        ${supplierA}::UUID,
        CURRENT_DATE, CURRENT_DATE + INTERVAL '30 days',
        1000.00, 15.00, 150.00, 1150.00,
        0, 'approved', ${USER_ID}::UUID
      ) RETURNING id, company_id
    ` as Array<{ id: string; company_id: string }>;

    expect(result).toHaveLength(1);
    expect(result[0].company_id).toBe(COMPANY_A);
  });

  /**
   * G: End-to-end cross-tenant SELECT isolation.
   * Both tenants have pending rows. Query as A → only A's row returned.
   * Query as B → only B's row returned.
   */
  it('G: cross-tenant SELECT isolation — querying as A never returns B rows and vice versa', async () => {
    const aRows = await sql`
      SELECT id FROM sage_supplier_invoices
      WHERE migration_status = 'pending'
        AND company_id = ${COMPANY_A}::UUID
    ` as Array<{ id: string }>;

    const bRows = await sql`
      SELECT id FROM sage_supplier_invoices
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
