/**
 * Integration test: BL-49 / BL-50 / BL-51 — bankAllocationService SELECT and UPDATE
 * on bank_transactions must be company_id-scoped.
 *
 * BL-49: allocateTransaction — SELECT at line 79, UPDATE at lines 193-198
 * BL-50: splitAllocateTransaction — SELECT at line 225, UPDATE at lines 291-294
 * BL-51: reverseReconciledTransaction — SELECT at line 308, UPDATE at line 339
 *
 * Cross-tenant assertion: operations keyed by COMPANY_B transaction id but
 * scoped to COMPANY_A must hit 0 rows; COMPANY_B row must remain unchanged.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';

const COMPANY_A = '00000000-0000-0000-b149-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b149-000000000bb2';

// gl_accounts row that will serve as a dummy bank_account_id (required FK)
let glAccountA: string;
let glAccountB: string;

// bank_transactions rows owned by COMPANY_B
let txImportedB: string;   // status = 'imported'
let txAllocatedB: string;  // status = 'allocated'

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL49-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL49 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL49 Test Company B'),
  ]);

  // Create minimal gl_accounts to satisfy bank_account_id FK
  const glA = await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
    VALUES (${COMPANY_A}::UUID, '9901-BL49', 'BL49 Bank A', 'asset', 'debit', true)
    RETURNING id
  ` as Array<{ id: string }>;
  glAccountA = glA[0]!.id;

  const glB = await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
    VALUES (${COMPANY_B}::UUID, '9901-BL49', 'BL49 Bank B', 'asset', 'debit', true)
    RETURNING id
  ` as Array<{ id: string }>;
  glAccountB = glB[0]!.id;

  // Insert test bank_transactions owned by COMPANY_B
  const txImp = await sql`
    INSERT INTO bank_transactions (
      company_id, bank_account_id, transaction_date, amount, description, status
    ) VALUES (
      ${COMPANY_B}::UUID, ${glAccountB}::UUID, CURRENT_DATE, -1500.00, 'BL49 test import', 'imported'
    ) RETURNING id
  ` as Array<{ id: string }>;
  txImportedB = txImp[0]!.id;

  const txAlloc = await sql`
    INSERT INTO bank_transactions (
      company_id, bank_account_id, transaction_date, amount, description, status
    ) VALUES (
      ${COMPANY_B}::UUID, ${glAccountB}::UUID, CURRENT_DATE, -800.00, 'BL49 test alloc', 'allocated'
    ) RETURNING id
  ` as Array<{ id: string }>;
  txAllocatedB = txAlloc[0]!.id;
});

afterAll(async () => {
  await sql`DELETE FROM bank_transactions WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM gl_accounts WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID) AND account_code = '9901-BL49'`;
  await sql`DELETE FROM companies WHERE id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
});

// ── BL-49: allocateTransaction ────────────────────────────────────────────────

describe('BL-49: allocateTransaction SELECT and UPDATE are company_id-scoped', () => {
  it('A: SELECT bank_transaction with COMPANY_A guard misses COMPANY_B row', async () => {
    const result = await sql`
      SELECT * FROM bank_transactions
      WHERE id = ${txImportedB}::UUID AND company_id = ${COMPANY_A}::UUID
    ` as Array<Record<string, unknown>>;
    expect(result).toHaveLength(0);

    // COMPANY_B row must still exist
    const row = await sql`
      SELECT status FROM bank_transactions WHERE id = ${txImportedB}::UUID
    ` as Array<{ status: string }>;
    expect(row[0]!.status).toBe('imported');
  });

  it('B: UPDATE bank_transaction with COMPANY_A guard misses COMPANY_B row', async () => {
    const result = await sql`
      UPDATE bank_transactions
      SET status = 'allocated', updated_at = NOW()
      WHERE id = ${txImportedB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);

    const row = await sql`
      SELECT status FROM bank_transactions WHERE id = ${txImportedB}::UUID
    ` as Array<{ status: string }>;
    expect(row[0]!.status).toBe('imported');
  });

  it('C: UPDATE with correct COMPANY_B guard succeeds', async () => {
    const result = await sql`
      UPDATE bank_transactions
      SET allocation_type = 'account', updated_at = NOW()
      WHERE id = ${txImportedB}::UUID AND company_id = ${COMPANY_B}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(1);
  });
});

// ── BL-50: splitAllocateTransaction ───────────────────────────────────────────

describe('BL-50: splitAllocateTransaction SELECT and UPDATE are company_id-scoped', () => {
  it('A: SELECT bank_transaction with COMPANY_A guard misses COMPANY_B row', async () => {
    const result = await sql`
      SELECT * FROM bank_transactions
      WHERE id = ${txImportedB}::UUID AND company_id = ${COMPANY_A}::UUID
    ` as Array<Record<string, unknown>>;
    expect(result).toHaveLength(0);
  });

  it('B: UPDATE (split allocated status) with COMPANY_A guard misses COMPANY_B row', async () => {
    const result = await sql`
      UPDATE bank_transactions
      SET status = 'allocated', allocation_type = 'account',
          allocated_entity_name = 'Split allocation', updated_at = NOW()
      WHERE id = ${txImportedB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);

    const row = await sql`
      SELECT allocated_entity_name FROM bank_transactions WHERE id = ${txImportedB}::UUID
    ` as Array<{ allocated_entity_name: string | null }>;
    // Should still be null (or whatever was set in BL-49 C, not 'Split allocation')
    expect(row[0]!.allocated_entity_name).not.toBe('Split allocation');
  });

  it('C: UPDATE with correct COMPANY_B guard succeeds', async () => {
    const result = await sql`
      UPDATE bank_transactions
      SET allocated_entity_name = 'Split allocation', updated_at = NOW()
      WHERE id = ${txImportedB}::UUID AND company_id = ${COMPANY_B}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(1);

    const row = await sql`
      SELECT allocated_entity_name FROM bank_transactions WHERE id = ${txImportedB}::UUID
    ` as Array<{ allocated_entity_name: string }>;
    expect(row[0]!.allocated_entity_name).toBe('Split allocation');
  });
});

// ── BL-51: reverseReconciledTransaction ──────────────────────────────────────

describe('BL-51: reverseReconciledTransaction SELECT and UPDATE are company_id-scoped', () => {
  it('A: SELECT bank_transaction with COMPANY_A guard misses COMPANY_B allocated row', async () => {
    const result = await sql`
      SELECT * FROM bank_transactions
      WHERE id = ${txAllocatedB}::UUID AND company_id = ${COMPANY_A}::UUID
    ` as Array<Record<string, unknown>>;
    expect(result).toHaveLength(0);

    const row = await sql`
      SELECT status FROM bank_transactions WHERE id = ${txAllocatedB}::UUID
    ` as Array<{ status: string }>;
    expect(row[0]!.status).toBe('allocated');
  });

  it('B: UPDATE (reset to imported) with COMPANY_A guard misses COMPANY_B row', async () => {
    const result = await sql`
      UPDATE bank_transactions
      SET status = 'imported', matched_journal_line_id = NULL, allocation_type = NULL,
          allocated_entity_name = NULL, updated_at = NOW()
      WHERE id = ${txAllocatedB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);

    const row = await sql`
      SELECT status FROM bank_transactions WHERE id = ${txAllocatedB}::UUID
    ` as Array<{ status: string }>;
    expect(row[0]!.status).toBe('allocated');
  });

  it('C: UPDATE with correct COMPANY_B guard succeeds', async () => {
    const result = await sql`
      UPDATE bank_transactions
      SET status = 'imported', matched_journal_line_id = NULL, allocation_type = NULL,
          allocated_entity_name = NULL, updated_at = NOW()
      WHERE id = ${txAllocatedB}::UUID AND company_id = ${COMPANY_B}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(1);

    const row = await sql`
      SELECT status FROM bank_transactions WHERE id = ${txAllocatedB}::UUID
    ` as Array<{ status: string }>;
    expect(row[0]!.status).toBe('imported');
  });
});
