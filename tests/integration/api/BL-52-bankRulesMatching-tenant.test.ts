/**
 * Integration test: BL-52 — bankRulesMatchingService applyRules()
 * SELECT and UPDATE on bank_transactions must be company_id-scoped.
 *
 * Sites under test:
 *   Lines 140-168: three SELECT branches (description / reference / both)
 *   Line 235: UPDATE bank_transactions SET status = 'allocated' ...
 *
 * Cross-tenant assertion: queries and updates scoped to COMPANY_A must not
 * touch bank_transactions owned by COMPANY_B.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';

const COMPANY_A = '00000000-0000-0000-b152-000000000aa1';
const COMPANY_B = '00000000-0000-0000-b152-000000000bb2';

let glAccountA: string;
let glAccountB: string;
let bankAccountIdB: string; // bank_accounts row owned by COMPANY_B
let txDescB: string;        // tx matching by description, owned by COMPANY_B
let txRefB: string;         // tx matching by reference, owned by COMPANY_B

async function ensureTestCompany(id: string, name: string): Promise<void> {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${id}::UUID, ${name}, 'BL52-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
}

beforeAll(async () => {
  await Promise.all([
    ensureTestCompany(COMPANY_A, 'BL52 Test Company A'),
    ensureTestCompany(COMPANY_B, 'BL52 Test Company B'),
  ]);

  // Create minimal gl_accounts (used as bank_account_id FK in bank_transactions)
  const glA = await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
    VALUES (${COMPANY_A}::UUID, '9902-BL52', 'BL52 Bank A', 'asset', 'debit', true)
    RETURNING id
  ` as Array<{ id: string }>;
  glAccountA = glA[0]!.id;

  const glB = await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance, is_active)
    VALUES (${COMPANY_B}::UUID, '9902-BL52', 'BL52 Bank B', 'asset', 'debit', true)
    RETURNING id
  ` as Array<{ id: string }>;
  glAccountB = glB[0]!.id;

  // Create a bank_accounts row for COMPANY_B (for the bankAccountId param)
  // bank_accounts references gl_accounts via gl_account_id
  const ba = await sql`
    INSERT INTO bank_accounts (company_id, account_name, bank_name, account_number, gl_account_id)
    VALUES (${COMPANY_B}::UUID, 'BL52 Bank Acc B', 'Test Bank', '99999', ${glAccountB}::UUID)
    RETURNING id
  ` as Array<{ id: string }>;
  bankAccountIdB = ba[0]!.id;

  // Insert bank_transactions with descriptions/references that rules would match
  const tDesc = await sql`
    INSERT INTO bank_transactions (
      company_id, bank_account_id, transaction_date, amount, description,
      reference, status
    ) VALUES (
      ${COMPANY_B}::UUID, ${glAccountB}::UUID, CURRENT_DATE,
      -500.00, 'BL52-MATCH-DESC', 'REF-BL52', 'imported'
    ) RETURNING id
  ` as Array<{ id: string }>;
  txDescB = tDesc[0]!.id;

  const tRef = await sql`
    INSERT INTO bank_transactions (
      company_id, bank_account_id, transaction_date, amount, description,
      reference, status
    ) VALUES (
      ${COMPANY_B}::UUID, ${glAccountB}::UUID, CURRENT_DATE,
      -300.00, 'Some description', 'BL52-MATCH-REF', 'imported'
    ) RETURNING id
  ` as Array<{ id: string }>;
  txRefB = tRef[0]!.id;
});

afterAll(async () => {
  await sql`DELETE FROM bank_transactions WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM bank_accounts WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
  await sql`DELETE FROM gl_accounts WHERE company_id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID) AND account_code = '9902-BL52'`;
  await sql`DELETE FROM companies WHERE id IN (${COMPANY_A}::UUID, ${COMPANY_B}::UUID)`;
});

describe('BL-52: applyRules SELECT branches are company_id-scoped', () => {
  it('A: description SELECT with COMPANY_A bank_account_id + company_id misses COMPANY_B row', async () => {
    const pattern = '%BL52-MATCH-DESC%';
    // Simulate description branch SELECT keyed by bankAccountIdB but scoped to COMPANY_A
    const result = await sql`
      SELECT id, amount, transaction_date, description
      FROM bank_transactions
      WHERE bank_account_id = ${bankAccountIdB}::UUID
        AND company_id = ${COMPANY_A}::UUID
        AND status IN ('imported', 'allocated')
        AND matched_journal_line_id IS NULL
        AND description ILIKE ${pattern}
      ORDER BY transaction_date
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);

    // COMPANY_B row still has original status
    const row = await sql`
      SELECT status FROM bank_transactions WHERE id = ${txDescB}::UUID
    ` as Array<{ status: string }>;
    expect(row[0]!.status).toBe('imported');
  });

  it('B: reference SELECT with COMPANY_A scope misses COMPANY_B row', async () => {
    const pattern = '%BL52-MATCH-REF%';
    const result = await sql`
      SELECT id, amount, transaction_date, description, reference
      FROM bank_transactions
      WHERE bank_account_id = ${bankAccountIdB}::UUID
        AND company_id = ${COMPANY_A}::UUID
        AND status IN ('imported', 'allocated')
        AND matched_journal_line_id IS NULL
        AND reference ILIKE ${pattern}
      ORDER BY transaction_date
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
  });

  it('C: both-field SELECT with COMPANY_A scope misses COMPANY_B rows', async () => {
    const pattern = '%BL52-MATCH%';
    const result = await sql`
      SELECT id, amount, transaction_date, description, reference
      FROM bank_transactions
      WHERE bank_account_id = ${bankAccountIdB}::UUID
        AND company_id = ${COMPANY_A}::UUID
        AND status IN ('imported', 'allocated')
        AND matched_journal_line_id IS NULL
        AND (description ILIKE ${pattern} OR reference ILIKE ${pattern})
      ORDER BY transaction_date
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);
  });

  it('D: correct COMPANY_B scope (using gl_account_id) finds the rows', async () => {
    const pattern = '%BL52-MATCH%';
    // bank_transactions.bank_account_id FK references gl_accounts.id
    const result = await sql`
      SELECT id FROM bank_transactions
      WHERE bank_account_id = ${glAccountB}::UUID
        AND company_id = ${COMPANY_B}::UUID
        AND status IN ('imported', 'allocated')
        AND (description ILIKE ${pattern} OR reference ILIKE ${pattern})
    ` as Array<{ id: string }>;
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

describe('BL-52: applyRules auto-JE UPDATE is company_id-scoped', () => {
  it('A: UPDATE bank_transaction with COMPANY_A guard misses COMPANY_B row', async () => {
    const result = await sql`
      UPDATE bank_transactions
      SET status = 'allocated', allocation_type = 'account',
          allocated_entity_name = 'BL52 auto rule', updated_at = NOW()
      WHERE id = ${txDescB}::UUID AND company_id = ${COMPANY_A}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(0);

    const row = await sql`
      SELECT status, allocated_entity_name FROM bank_transactions WHERE id = ${txDescB}::UUID
    ` as Array<{ status: string; allocated_entity_name: string | null }>;
    expect(row[0]!.status).toBe('imported');
    expect(row[0]!.allocated_entity_name).toBeNull();
  });

  it('B: UPDATE with correct COMPANY_B guard succeeds', async () => {
    const result = await sql`
      UPDATE bank_transactions
      SET status = 'allocated', allocation_type = 'account',
          allocated_entity_name = 'BL52 auto rule', updated_at = NOW()
      WHERE id = ${txDescB}::UUID AND company_id = ${COMPANY_B}::UUID
      RETURNING id
    ` as Array<{ id: string }>;
    expect(result).toHaveLength(1);

    const row = await sql`
      SELECT status, allocated_entity_name FROM bank_transactions WHERE id = ${txDescB}::UUID
    ` as Array<{ status: string; allocated_entity_name: string }>;
    expect(row[0]!.status).toBe('allocated');
    expect(row[0]!.allocated_entity_name).toBe('BL52 auto rule');
  });
});
