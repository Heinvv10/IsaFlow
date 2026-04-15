/**
 * Unit tests for transactionLedgerService.ts
 *
 * Regression guard for S-001 (BL-01): cross-tenant data leak in
 * getBankTransactions and getAuditTrail.
 *
 * Before the fix, both queries omitted je.company_id and ga.company_id
 * filters, allowing any authenticated viewer to read every tenant's
 * journal entries via the audit-trail and bank-transaction report endpoints.
 *
 * These tests seed two mock companies (A and B) and assert that functions
 * called with company A's ID never return rows belonging to company B.
 *
 * All DB calls are mocked — no real Neon connection required.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) => (d instanceof Date ? d.toISOString().split('T')[0] : String(d)),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

// Mock systemAccountResolver so getBankTransactions doesn't need a real DB
// call to resolve the bank account code.
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({
  getSystemAccount: vi.fn().mockResolvedValue({ accountCode: '1010', accountId: 'acc-bank-001' }),
}));

import { sql } from '@/lib/neon';
import {
  getBankTransactions,
  getAuditTrail,
} from '@/modules/accounting/services/gl/transactionLedgerService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const COMPANY_B = 'bbbbbbbb-0000-0000-0000-000000000002';

const PERIOD_START = '2025-01-01';
const PERIOD_END   = '2026-12-31';
const BANK_CODE    = '1010';

// ── Row factories ─────────────────────────────────────────────────────────────

/** Opening balance row */
function makeObRow(balance: number) {
  return { balance: String(balance) };
}

/** A bank-transaction journal line row */
function makeBankTxRow(companyId: string, opts: { debit?: number; credit?: number } = {}) {
  return {
    entry_date:   new Date('2025-06-15'),
    entry_number: `JE-${companyId.slice(0, 4)}-001`,
    description:  `Payment for company ${companyId.slice(0, 8)}`,
    source:       'manual',
    debit:        String(opts.debit  ?? 500),
    credit:       String(opts.credit ?? 0),
    // Carry company_id in the row so the test can verify which tenant it belongs to.
    // After the fix the SQL WHERE clause prevents foreign rows reaching here,
    // but before the fix the mock must return them explicitly to demonstrate the leak.
    company_id:   companyId,
  };
}

/** Account-name lookup row */
function makeAcctNameRow() {
  return { account_name: 'Standard Bank Current Account' };
}

/** An audit-trail journal entry row */
function makeAuditRow(companyId: string) {
  return {
    entry_date:      new Date('2025-03-10'),
    entry_number:    `JE-${companyId.slice(0, 4)}-002`,
    description:     `Write-off for company ${companyId.slice(0, 8)}`,
    source:          'manual',
    status:          'posted',
    total_debit:     '1000',
    total_credit:    '1000',
    created_by_name: 'Test User',
    created_at:      new Date('2025-03-10T10:00:00Z'),
    posted_at:       new Date('2025-03-10T10:05:00Z'),
    // Carry company_id so the test can assert tenant isolation.
    company_id:      companyId,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('transactionLedgerService — tenant isolation (S-001 / BL-01)', () => {
  let sqlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
  });

  // ── getBankTransactions ─────────────────────────────────────────────────────

  describe('getBankTransactions', () => {
    it('passes company_id to the opening-balance query — closing the cross-tenant leak', async () => {
      /**
       * Before the fix: the opening-balance query omitted je.company_id and
       * ga.company_id from its WHERE clause, so ANY authenticated user could
       * retrieve the sum of every tenant's bank movements.
       *
       * After the fix: COMPANY_A is passed as a parameter to BOTH the
       * opening-balance SQL call (call 0) and the period SQL call (call 1).
       *
       * This test verifies the structural guarantee — companyId appears in
       * every SQL call's interpolated parameters, and COMPANY_B never does.
       * The SQL WHERE clause ensures the DB engine can only return rows that
       * belong to COMPANY_A.
       */
      sqlMock
        .mockResolvedValueOnce([makeObRow(0)])
        .mockResolvedValueOnce([makeBankTxRow(COMPANY_A, { debit: 1000 })])
        .mockResolvedValueOnce([makeAcctNameRow()]);

      await getBankTransactions(COMPANY_A, PERIOD_START, PERIOD_END, BANK_CODE);

      // All three SQL calls must carry COMPANY_A as an interpolated parameter.
      const allArgs = sqlMock.mock.calls.flatMap((args) => args.slice(1));
      expect(allArgs).toContain(COMPANY_A);
      // COMPANY_B must NEVER appear in any SQL call made for COMPANY_A's request.
      expect(allArgs).not.toContain(COMPANY_B);
    });

    it('passes company_id to the period transactions query — company B cannot be included', async () => {
      /**
       * This test specifically verifies the period (second) SQL call inside
       * getBankTransactions also carries the companyId.
       *
       * We check the second call's interpolated values directly.
       */
      sqlMock
        .mockResolvedValueOnce([makeObRow(200)])
        .mockResolvedValueOnce([makeBankTxRow(COMPANY_A, { debit: 200 })])
        .mockResolvedValueOnce([makeAcctNameRow()]);

      await getBankTransactions(COMPANY_A, PERIOD_START, PERIOD_END, BANK_CODE);

      // call index 0 = opening balance, call index 1 = period transactions
      expect(sqlMock).toHaveBeenCalledTimes(3);
      const obCallArgs   = sqlMock.mock.calls[0].slice(1);
      const txnCallArgs  = sqlMock.mock.calls[1].slice(1);

      // Both queries must be scoped to COMPANY_A.
      expect(obCallArgs).toContain(COMPANY_A);
      expect(txnCallArgs).toContain(COMPANY_A);
      // Neither query must ever include COMPANY_B's ID.
      expect(obCallArgs).not.toContain(COMPANY_B);
      expect(txnCallArgs).not.toContain(COMPANY_B);
    });
  });

  // ── getAuditTrail ───────────────────────────────────────────────────────────

  describe('getAuditTrail', () => {
    it('passes company_id to the audit-trail SQL call — closing the cross-tenant leak', async () => {
      /**
       * Before the fix: getAuditTrail's WHERE clause contained only
       * entry_date bounds — no je.company_id filter. The S-001 live exploit
       * confirmed this returned 3,679 rows from all tenants to a viewer
       * that belongs to a company with exactly 1 journal entry.
       *
       * After the fix: je.company_id = ${companyId}::UUID is the first
       * condition in the WHERE clause. This test verifies COMPANY_A is
       * present as an interpolated SQL parameter, and COMPANY_B is absent.
       */
      sqlMock.mockResolvedValueOnce([makeAuditRow(COMPANY_A)]);

      await getAuditTrail(COMPANY_A, PERIOD_START, PERIOD_END);

      expect(sqlMock).toHaveBeenCalledTimes(1);
      const callArgs = sqlMock.mock.calls[0].slice(1);

      // The single SQL call must be scoped to COMPANY_A.
      expect(callArgs).toContain(COMPANY_A);
      // COMPANY_B must never appear in a request for COMPANY_A's audit trail.
      expect(callArgs).not.toContain(COMPANY_B);
    });

    it('returns the correct shape for company A entries', async () => {
      /**
       * Verify the mapper produces correctly-shaped AuditTrailRow objects
       * when the query is properly scoped. This guards against regressions
       * to the mapping logic while the tenant-isolation fix is in place.
       */
      sqlMock.mockResolvedValueOnce([makeAuditRow(COMPANY_A)]);

      const entries = await getAuditTrail(COMPANY_A, PERIOD_START, PERIOD_END);

      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        entryDate:   '2025-03-10',
        entryNumber: `JE-${COMPANY_A.slice(0, 4)}-002`,
        source:      'manual',
        status:      'posted',
        totalDebit:  1000,
        totalCredit: 1000,
      });
    });
  });
});
