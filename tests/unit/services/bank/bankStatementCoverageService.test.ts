/**
 * `bank_statement_coverage` — the report that finds a missing statement without
 * a second system to compare against.
 *
 * The 203 missing BT1 lines on Velocity Fibre were found only by holding
 * IsaFlow next to Sage. Nothing in the product could say "this account has
 * fourteen months of history and a four-month hole in the middle", or "the GL
 * says R3.46m and the statements say R1.02m", and so the hole survived.
 *
 * Everything here is a completeness claim, so the tests are about the shapes
 * that let a gap hide: an account with no transactions must still appear, an
 * inactive account must still appear, and the three balances must be reported
 * separately rather than reconciled into one number that agrees with itself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/bank/bankCoverageQueries', () => ({
  fetchCoverageAccounts: vi.fn(),
  fetchCoverageMonths: vi.fn(),
  fetchCoverageGaps: vi.fn(),
  fetchDuplicateReferences: vi.fn(),
}));
vi.mock('@/modules/accounting/services/bank/cashBalanceService', () => ({
  getCashBalance: vi.fn(),
}));

import {
  fetchCoverageAccounts,
  fetchCoverageGaps,
  fetchCoverageMonths,
  fetchDuplicateReferences,
} from '@/modules/accounting/services/bank/bankCoverageQueries';
import { getCashBalance } from '@/modules/accounting/services/bank/cashBalanceService';
import { getBankStatementCoverage } from '@/modules/accounting/services/bank/bankStatementCoverageService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const A1 = '11111111-1111-1111-1111-111111111111';
const A2 = '22222222-2222-2222-2222-222222222222';
const AS_AT = '2026-09-03';

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(fetchCoverageAccounts).mockResolvedValue([
    {
      bankAccountId: A1, accountCode: '1544331', accountName: 'ABSA Cheque', isActive: true,
      firstTransactionDate: '2025-04-01', lastTransactionDate: '2026-08-24',
      transactionCount: 6842, netMovement: 127408.56,
      openingBalanceAmount: null, openingBalanceAsAt: null,
      latestImportedAt: '2026-08-25T06:00:00.000Z',
    },
    {
      bankAccountId: A2, accountCode: '1544333', accountName: 'SBSA', isActive: false,
      firstTransactionDate: null, lastTransactionDate: null,
      transactionCount: 0, netMovement: 0,
      openingBalanceAmount: 5000, openingBalanceAsAt: '2025-03-01',
      latestImportedAt: null,
    },
  ]);
  vi.mocked(fetchCoverageMonths).mockResolvedValue([
    { bankAccountId: A1, month: '2025-04', transactionCount: 10, net: 100, debits: 50, credits: 150 },
    { bankAccountId: A1, month: '2025-05', transactionCount: 4, net: -20, debits: 20, credits: 0 },
  ]);
  vi.mocked(fetchCoverageGaps).mockResolvedValue([
    { bankAccountId: A1, afterDate: '2025-12-20', beforeDate: '2026-04-14', missingDays: 114 },
  ]);
  vi.mocked(fetchDuplicateReferences).mockResolvedValue([
    { bankAccountId: A1, reference: 'FNB-8842', count: 3, totalAmount: -300, transactionIds: ['t1', 't2', 't3'] },
  ]);
  vi.mocked(getCashBalance).mockResolvedValue({
    asAt: AS_AT,
    total: 3353164.26,
    accounts: [
      { accountId: A1, accountCode: '1544331', accountName: 'ABSA Cheque', isActive: true, glBalance: 3353164.26 },
      { accountId: A2, accountCode: '1544333', accountName: 'SBSA', isActive: false, glBalance: 0 },
    ],
    deactivatedWithBalance: [],
    postedThrough: '2026-09-03T03:10:16.064Z',
  });
});

describe('getBankStatementCoverage', () => {
  it('passes ctx company and the reporting date to every query', async () => {
    await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    for (const fn of [fetchCoverageAccounts, fetchCoverageMonths, fetchCoverageGaps, fetchDuplicateReferences]) {
      expect(vi.mocked(fn).mock.calls[0]?.[0]).toBe(COMPANY);
    }
    expect(vi.mocked(getCashBalance)).toHaveBeenCalledWith(COMPANY, AS_AT);
  });

  it('reports the GL, statement and computed balances SEPARATELY', async () => {
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    const a1 = result.accounts.find((a) => a.bankAccountId === A1)!;
    expect(a1.glBalance).toBeCloseTo(3353164.26, 2);
    expect(a1.statementBalance).toBeCloseTo(127408.56, 2);
    // No opening balance recorded, so computed == statement.
    expect(a1.computedBalance).toBeCloseTo(127408.56, 2);
    expect(a1.glVsComputedDifference).toBeCloseTo(3225755.70, 2);
  });

  it('adds a recorded opening balance to the computed balance', async () => {
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    const a2 = result.accounts.find((a) => a.bankAccountId === A2)!;
    expect(a2.openingBalance).toEqual({ amount: 5000, asAt: '2025-03-01' });
    expect(a2.computedBalance).toBe(5000);
    expect(a2.glVsComputedDifference).toBe(-5000);
  });

  it('keeps an account with ZERO transactions in the report', async () => {
    // An account with no statement lines is the single most important row here:
    // it is what a four-month import hole looks like from the far side.
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    const a2 = result.accounts.find((a) => a.bankAccountId === A2)!;
    expect(a2.transactionCount).toBe(0);
    expect(a2.firstTransactionDate).toBeNull();
    expect(a2.months).toEqual([]);
  });

  it('keeps a DEACTIVATED account in the report', async () => {
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    expect(result.accounts.map((a) => a.bankAccountId)).toContain(A2);
    expect(result.accounts.find((a) => a.bankAccountId === A2)!.isActive).toBe(false);
  });

  it('attaches months, gaps and duplicate references to the right account', async () => {
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    const a1 = result.accounts.find((a) => a.bankAccountId === A1)!;
    expect(a1.months.map((m) => m.month)).toEqual(['2025-04', '2025-05']);
    expect(a1.gaps).toHaveLength(1);
    expect(a1.gaps[0]!.missingDays).toBe(114);
    expect(a1.duplicateReferences[0]!.reference).toBe('FNB-8842');
    const a2 = result.accounts.find((a) => a.bankAccountId === A2)!;
    expect(a2.gaps).toEqual([]);
    expect(a2.duplicateReferences).toEqual([]);
  });

  it('counts the days since the last transaction, so a stale feed is a number', async () => {
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    const a1 = result.accounts.find((a) => a.bankAccountId === A1)!;
    expect(a1.staleDays).toBe(10); // 2026-08-24 → 2026-09-03
    const a2 = result.accounts.find((a) => a.bankAccountId === A2)!;
    expect(a2.staleDays).toBeNull(); // never had one
  });

  it('totals the three balances across every account', async () => {
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    expect(result.totals.glBalance).toBeCloseTo(3353164.26, 2);
    expect(result.totals.statementBalance).toBeCloseTo(127408.56, 2);
    expect(result.totals.computedBalance).toBeCloseTo(132408.56, 2);
    expect(result.totals.transactionCount).toBe(6842);
  });

  it('reports posted_through from the ledger, not from now()', async () => {
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    expect(result.postedThrough).toBe('2026-09-03T03:10:16.064Z');
  });

  it('falls back to the newest import when nothing is posted to the ledger', async () => {
    vi.mocked(getCashBalance).mockResolvedValue({
      asAt: AS_AT, total: 0, accounts: [], deactivatedWithBalance: [], postedThrough: null,
    });
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    expect(result.postedThrough).toBe('2026-08-25T06:00:00.000Z');
  });

  it('reports a GL balance for an account the cash figure does not list, as zero', async () => {
    vi.mocked(getCashBalance).mockResolvedValue({
      asAt: AS_AT, total: 0, accounts: [], deactivatedWithBalance: [], postedThrough: null,
    });
    const result = await getBankStatementCoverage(COMPANY, { asAt: AS_AT });
    expect(result.accounts.every((a) => a.glBalance === 0)).toBe(true);
  });

  it('narrows to one account when asked, and still returns the same shape', async () => {
    await getBankStatementCoverage(COMPANY, { asAt: AS_AT, bankAccountId: A1 });
    expect(vi.mocked(fetchCoverageAccounts).mock.calls[0]?.[2]).toBe(A1);
  });

  it('passes the minimum gap length through rather than hard-coding it', async () => {
    await getBankStatementCoverage(COMPANY, { asAt: AS_AT, minGapDays: 30 });
    expect(vi.mocked(fetchCoverageGaps).mock.calls[0]?.[2]).toBe(30);
  });
});
