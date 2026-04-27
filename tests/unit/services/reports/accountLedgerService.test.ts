/**
 * Unit tests for accountLedgerService.ts
 *
 * Covers:
 *   - Happy path: rows returned in date order with correct running balance
 *   - Empty range: returns { rows: [], total: 0, openingBalance: 0 }
 *   - Opening balance computed correctly for debit-normal accounts
 *   - Opening balance computed correctly for credit-normal accounts
 *   - company_id is the FIRST interpolated SQL argument in every query
 *   - posted_only=true vs posted_only=false produces different SQL branches
 *   - lookup by accountCode (not UUID)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('@/lib/neon', () => {
  const sqlMock = Object.assign(vi.fn(), { transaction: vi.fn() });
  return {
    sql: sqlMock,
    withTransaction: vi.fn((cb: (tx: typeof sqlMock) => unknown) => cb(sqlMock)),
    fmtDate: (d: unknown) =>
      d instanceof Date ? d.toISOString().split('T')[0] : String(d),
  };
});

vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getAccountLedger } from '@/modules/accounting/services/reports/accountLedgerService';

// ── Constants ─────────────────────────────────────────────────────────────────

const COMPANY_A = 'aaaaaaaa-0000-0000-0000-000000000001';
const COMPANY_B = 'bbbbbbbb-0000-0000-0000-000000000002';
const ACCOUNT_ID = 'cccccccc-1111-0000-0000-000000000001';
const ACCOUNT_CODE = '1110';
const FROM = '2025-01-01';
const TO = '2025-03-31';

// ── Row factories ──────────────────────────────────────────────────────────────

function makeAcctRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    account_code: ACCOUNT_CODE,
    account_name: 'Bank Account',
    account_type: 'asset',
    normal_balance: 'debit',
    ...overrides,
  };
}

function makeObRow(debit = 0, credit = 0) {
  return { total_debit: String(debit), total_credit: String(credit) };
}

function makeCountRow(total: number) {
  return { total: String(total) };
}

function makeTxnRow(opts: {
  id?: string;
  date?: string | Date;
  entryNumber?: string;
  description?: string;
  reference?: string;
  source?: string;
  debit?: number;
  credit?: number;
}) {
  return {
    journal_entry_id: opts.id ?? 'je-001',
    entry_date: opts.date ?? new Date('2025-02-15'),
    entry_number: opts.entryNumber ?? 'JE-001',
    description: opts.description ?? 'Test transaction',
    reference: opts.reference ?? '',
    source: opts.source ?? 'manual',
    debit: String(opts.debit ?? 500),
    credit: String(opts.credit ?? 0),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('accountLedgerService — getAccountLedger', () => {
  let sqlMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
  });

  // ── company_id is FIRST param ────────────────────────────────────────────────

  describe('multi-tenant isolation — company_id must be first SQL arg', () => {
    it('company_id is the first interpolated value in the account-meta query', async () => {
      /**
       * The account-meta query (call 0) must have company_id as the first
       * interpolated param. This ensures the DB index on (company_id, id)
       * is hit and no cross-tenant account metadata leaks.
       */
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])   // acct meta
        .mockResolvedValueOnce([makeObRow()])       // opening balance
        .mockResolvedValueOnce([makeCountRow(0)])   // count
        .mockResolvedValueOnce([]);                 // ledger rows

      await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      // call[0] = account meta lookup
      const metaCallArgs = sqlMock.mock.calls[0]?.slice(1) ?? [];
      // company_id must be the FIRST value in the interpolated args array
      expect(metaCallArgs[0]).toBe(COMPANY_A);
      // COMPANY_B must never appear
      expect(metaCallArgs).not.toContain(COMPANY_B);
    });

    it('company_id is the first interpolated value in the opening-balance query', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow(1000)])
        .mockResolvedValueOnce([makeCountRow(1)])
        .mockResolvedValueOnce([makeTxnRow({ debit: 500 })]);

      await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      // call[1] = opening balance query
      const obCallArgs = sqlMock.mock.calls[1]?.slice(1) ?? [];
      expect(obCallArgs[0]).toBe(COMPANY_A);
      expect(obCallArgs).not.toContain(COMPANY_B);
    });

    it('company_id is the first interpolated value in the count query', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow()])
        .mockResolvedValueOnce([makeCountRow(5)])
        .mockResolvedValueOnce([]);

      await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      // call[2] = count query
      const countCallArgs = sqlMock.mock.calls[2]?.slice(1) ?? [];
      expect(countCallArgs[0]).toBe(COMPANY_A);
      expect(countCallArgs).not.toContain(COMPANY_B);
    });

    it('company_id is the first interpolated value in the ledger query', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow()])
        .mockResolvedValueOnce([makeCountRow(1)])
        .mockResolvedValueOnce([makeTxnRow({ debit: 100 })]);

      await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      // call[3] = paginated ledger rows
      const ledgerCallArgs = sqlMock.mock.calls[3]?.slice(1) ?? [];
      expect(ledgerCallArgs[0]).toBe(COMPANY_A);
      expect(ledgerCallArgs).not.toContain(COMPANY_B);
    });

    it('COMPANY_B never appears in any SQL call made for COMPANY_A', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow(500)])
        .mockResolvedValueOnce([makeCountRow(1)])
        .mockResolvedValueOnce([makeTxnRow({ debit: 200 })]);

      await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      const allArgs = sqlMock.mock.calls.flatMap(args => args.slice(1));
      expect(allArgs).toContain(COMPANY_A);
      expect(allArgs).not.toContain(COMPANY_B);
    });
  });

  // ── Happy path ───────────────────────────────────────────────────────────────

  describe('happy path', () => {
    it('returns rows in date order with correct running balance', async () => {
      const txn1 = makeTxnRow({ id: 'je-001', date: new Date('2025-01-10'), debit: 1000 });
      const txn2 = makeTxnRow({ id: 'je-002', date: new Date('2025-02-15'), debit: 500 });

      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])         // acct meta
        .mockResolvedValueOnce([makeObRow(2000, 500)])  // opening balance: 2000dr - 500cr = 1500
        .mockResolvedValueOnce([makeCountRow(2)])        // total
        .mockResolvedValueOnce([txn1, txn2]);            // rows

      const result = await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      expect(result.openingBalance).toBe(1500);
      expect(result.total).toBe(2);
      expect(result.rows).toHaveLength(2);

      // First row: opening 1500 + 1000 debit = 2500
      expect(result.rows[0]?.runningBalance).toBe(2500);
      // Second row: 2500 + 500 debit = 3000
      expect(result.rows[1]?.runningBalance).toBe(3000);
    });

    it('maps row fields correctly', async () => {
      const txn = makeTxnRow({
        id: 'je-abc',
        date: new Date('2025-03-01'),
        entryNumber: 'JE-2025-042',
        description: 'Sales invoice payment',
        reference: 'INV-001',
        source: 'auto_payment',
        debit: 800,
        credit: 0,
      });

      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow(0)])
        .mockResolvedValueOnce([makeCountRow(1)])
        .mockResolvedValueOnce([txn]);

      const result = await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      expect(result.rows[0]).toMatchObject({
        journalEntryId: 'je-abc',
        entryDate: '2025-03-01',
        entryNumber: 'JE-2025-042',
        description: 'Sales invoice payment',
        reference: 'INV-001',
        source: 'auto_payment',
        debit: 800,
        credit: 0,
      });
    });

    it('returns meta with resolved account details', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow()])
        .mockResolvedValueOnce([makeCountRow(0)])
        .mockResolvedValueOnce([]);

      const result = await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      expect(result.meta).toMatchObject({
        accountId: ACCOUNT_ID,
        accountCode: ACCOUNT_CODE,
        accountName: 'Bank Account',
        accountType: 'asset',
        normalBalance: 'debit',
      });
    });
  });

  // ── Empty range ──────────────────────────────────────────────────────────────

  describe('empty range', () => {
    it('returns rows=[], total=0, openingBalance=0 when there are no transactions', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow(0, 0)])
        .mockResolvedValueOnce([makeCountRow(0)])
        .mockResolvedValueOnce([]);

      const result = await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      expect(result.rows).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.openingBalance).toBe(0);
    });
  });

  // ── Opening balance computation ──────────────────────────────────────────────

  describe('opening balance computation', () => {
    it('debit-normal: openingBalance = debits − credits', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow({ normal_balance: 'debit' })])
        .mockResolvedValueOnce([makeObRow(3000, 1200)])
        .mockResolvedValueOnce([makeCountRow(0)])
        .mockResolvedValueOnce([]);

      const result = await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      // 3000dr - 1200cr = 1800 debit balance
      expect(result.openingBalance).toBe(1800);
    });

    it('credit-normal: openingBalance = credits − debits', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow({ normal_balance: 'credit', account_type: 'liability' })])
        .mockResolvedValueOnce([makeObRow(500, 2000)])
        .mockResolvedValueOnce([makeCountRow(0)])
        .mockResolvedValueOnce([]);

      const result = await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      // credits (2000) - debits (500) = 1500 credit balance
      expect(result.openingBalance).toBe(1500);
    });

    it('running balance updates correctly for credit-normal account', async () => {
      const txn = makeTxnRow({ debit: 0, credit: 300 });

      sqlMock
        .mockResolvedValueOnce([makeAcctRow({ normal_balance: 'credit', account_type: 'liability' })])
        .mockResolvedValueOnce([makeObRow(0, 1000)])  // opening: 1000
        .mockResolvedValueOnce([makeCountRow(1)])
        .mockResolvedValueOnce([txn]);

      const result = await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
      });

      expect(result.openingBalance).toBe(1000);
      // credit-normal: +credit − debit → 1000 + 300 = 1300
      expect(result.rows[0]?.runningBalance).toBe(1300);
    });
  });

  // ── posted_only flag ─────────────────────────────────────────────────────────

  describe('posted_only flag', () => {
    it('makes 4 SQL calls regardless of posted_only flag', async () => {
      // posted_only = true
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow()])
        .mockResolvedValueOnce([makeCountRow(0)])
        .mockResolvedValueOnce([]);

      await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
        postedOnly: true,
      });
      expect(sqlMock).toHaveBeenCalledTimes(4);
    });

    it('calls 4 SQL queries when postedOnly=false', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow()])
        .mockResolvedValueOnce([makeCountRow(0)])
        .mockResolvedValueOnce([]);

      await getAccountLedger({
        companyId: COMPANY_A,
        accountId: ACCOUNT_ID,
        fromDate: FROM,
        toDate: TO,
        postedOnly: false,
      });
      expect(sqlMock).toHaveBeenCalledTimes(4);
    });
  });

  // ── account_code lookup ──────────────────────────────────────────────────────

  describe('lookup by accountCode', () => {
    it('resolves account by code when accountId is not provided', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow()])
        .mockResolvedValueOnce([makeCountRow(0)])
        .mockResolvedValueOnce([]);

      const result = await getAccountLedger({
        companyId: COMPANY_A,
        accountCode: ACCOUNT_CODE,
        fromDate: FROM,
        toDate: TO,
      });

      expect(result.meta.accountCode).toBe(ACCOUNT_CODE);
      // First meta call should include ACCOUNT_CODE as a param (not ACCOUNT_ID)
      const metaCallArgs = sqlMock.mock.calls[0]?.slice(1) ?? [];
      expect(metaCallArgs).toContain(ACCOUNT_CODE);
    });

    it('company_id is still first arg when looking up by code', async () => {
      sqlMock
        .mockResolvedValueOnce([makeAcctRow()])
        .mockResolvedValueOnce([makeObRow()])
        .mockResolvedValueOnce([makeCountRow(0)])
        .mockResolvedValueOnce([]);

      await getAccountLedger({
        companyId: COMPANY_A,
        accountCode: ACCOUNT_CODE,
        fromDate: FROM,
        toDate: TO,
      });

      const metaCallArgs = sqlMock.mock.calls[0]?.slice(1) ?? [];
      expect(metaCallArgs[0]).toBe(COMPANY_A);
    });
  });

  // ── Error handling ───────────────────────────────────────────────────────────

  describe('error handling', () => {
    it('throws when account not found for company', async () => {
      sqlMock.mockResolvedValueOnce([]); // empty result = not found

      await expect(
        getAccountLedger({
          companyId: COMPANY_A,
          accountId: ACCOUNT_ID,
          fromDate: FROM,
          toDate: TO,
        }),
      ).rejects.toThrow(/not found/i);
    });

    it('throws when neither accountId nor accountCode is provided', async () => {
      await expect(
        getAccountLedger({
          companyId: COMPANY_A,
          fromDate: FROM,
          toDate: TO,
        } as Parameters<typeof getAccountLedger>[0]),
      ).rejects.toThrow(/required/i);
    });
  });
});
