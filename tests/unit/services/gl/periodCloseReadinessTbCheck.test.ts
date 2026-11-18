/**
 * The trial-balance readiness check.
 * Split from periodCloseReadinessService.test.ts as a pure move; shared setup in periodCloseReadiness.fixture.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockedFunction } from 'vitest';
import { MockSqlFragment, mockUnsafe } from '../../helpers/sqlFragmentMock';
import { UNRECONCILED_LINE_SQL } from '@/modules/accounting/services/bank/unreconciledLineSql';
import { fakeRegistry, resetFakeRegistry } from '../../../helpers/fiscalYearSqlFake';

vi.mock('@/lib/neon', () => ({
  // `unsafe` is part of the real client and the AR/AP sub-ledger checks splice
  // a fragment through it (shared/softDeleteLedgerPresence — the as-at
  // soft-delete predicate). It must NOT be the same spy as `sql`: a fragment
  // build is not a query, and counting it as one consumes a queued
  // mockResolvedValueOnce and shifts every row after it.
  sql: Object.assign(vi.fn(), { unsafe: mockUnsafe }),
  // withSavepoint degrades to a plain fn() call when there is no request tx
  // (as in these unit tests and prod cron paths) — it just runs the check.
  withSavepoint: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
}));
// The trial balance reads its years from the registry (March-based unless a test sets fakeRegistry.years).
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry',
  async () => (await import('../../../helpers/fiscalYearSqlFake')).registryMock());
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodById: vi.fn(),
}));
// The AR / AP ties read reconcileSubledger (point in time), not raw SQL. It is
// mocked to a clean tie here; its verdict rules are tested in
// tests/unit/services/gl/subLedgerTieCheck.test.ts.
vi.mock('@/modules/accounting/services/reconciliation/subledgerReconciliationService', () => ({
  reconcileSubledger: vi.fn(),
}));

import { sql, withSavepoint } from '@/lib/neon';
import { log } from '@/lib/logger';
import { getFiscalPeriodById } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import { bankReconciledCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/bankReconciledCheck';
import { unpostedJournalsCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/unpostedJournalsCheck';
import { tbBalancedCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/tbBalancedCheck';
import { BALANCE_TOLERANCE } from '@/modules/accounting/services/gl/trialBalanceService';
import { vatReviewedCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/vatReviewedCheck';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';
import {
  reconcileSubledger,
  type SubledgerReconciliation,
} from '@/modules/accounting/services/reconciliation/subledgerReconciliationService';
import {
  mockSql, mockGetPeriodById, mockReconcile, tiedReconciliation, COMPANY_A, COMPANY_B, PERIOD_ID, makePeriod,
  mockAllChecksPass,
} from './periodCloseReadiness.fixture';

describe('tbBalancedCheck', () => {
  /**
   * `vi.clearAllMocks()` clears recorded calls but NOT queued
   * `mockResolvedValueOnce` values. This check short-circuits on a bad fiscal
   * year without consuming its queue, so an undrained queue leaked into the
   * next test — and out of this describe entirely. Reset the queue on both
   * edges rather than relying on every test consuming exactly what it primes.
   */
  beforeEach(() => {
    vi.clearAllMocks();
    mockSql.mockReset();
    resetFakeRegistry();
  });
  afterEach(() => mockSql.mockReset());

  const PERIOD = { id: PERIOD_ID };

  /**
   * Queries in order: this period's postings, then getTrialBalanceReport's
   * three (period basis, balances, brought-forward profit).
   */
  function prime(
    postings: { debit: string; credit: string },
    tbRows: Array<Record<string, unknown>>,
  ) {
    mockSql
      .mockResolvedValueOnce([{ total_debit: postings.debit, total_credit: postings.credit }])
      .mockResolvedValueOnce([{ start_date: '2026-02-01', end_date: '2026-02-28' }])
      .mockResolvedValueOnce(tbRows)
      .mockResolvedValueOnce([{ retained: '0' }]);
  }

  const tbRow = (o: Record<string, unknown> = {}) => ({
    account_code: '1000', account_name: 'Bank', account_type: 'asset', normal_balance: 'debit',
    closing_debit: '10000.00', closing_credit: '0', period_debit: '10000.00', period_credit: '0', ...o,
  });

  const balancedTb = [
    tbRow(),
    tbRow({
      account_code: '2001', account_type: 'liability', normal_balance: 'credit',
      closing_debit: '0', closing_credit: '10000.00', period_debit: '0', period_credit: '10000.00',
    }),
  ];

  it('passes when the trial balance and the period postings both balance', async () => {
    prime({ debit: '10000.00', credit: '10000.00' }, balancedTb);
    const item = await tbBalancedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  /**
   * The label says "Trial balance balanced" and links to the trial balance, so
   * the check must actually read it. Asserting only on this period's postings
   * was a true statement about a report it never looked at.
   */
  it('fails on an out-of-balance TRIAL BALANCE even when this period posted evenly', async () => {
    prime({ debit: '10000.00', credit: '10000.00' }, [tbRow({ closing_debit: '10200.00' })]);
    const item = await tbBalancedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('Trial balance');
    expect(item.fixHref).toBe('/accounting/trial-balance');
  });

  /**
   * Offsetting errors across two periods leave the cumulative trial balance
   * balanced while this period is broken — the cumulative check alone misses it.
   */
  it('fails on unbalanced period postings even when the trial balance balances', async () => {
    prime({ debit: '10200.00', credit: '10000.00' }, balancedTb);
    const item = await tbBalancedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('fail');
    expect(item.reason).toContain("period's own postings");
    expect(item.reason).toContain('200.00');
  });

  it('reports the account count the balanced assertion covers', async () => {
    prime({ debit: '10000.00', credit: '10000.00' }, balancedTb);
    const item = await tbBalancedCheck(COMPANY_A, PERIOD);
    expect(item.reason).toContain('2 accounts');
  });

  it('shares one tolerance with the trial balance service', async () => {
    // Half a cent, not the 0.01 this check used to carry independently.
    expect(BALANCE_TOLERANCE).toBe(0.005);
    prime({ debit: '10000.001', credit: '10000.00' }, balancedTb);
    expect((await tbBalancedCheck(COMPANY_A, PERIOD)).status).toBe('pass');
  });

  it('SQL references gl_journal_lines and gl_journal_entries', async () => {
    prime({ debit: '0', credit: '0' }, []);
    await tbBalancedCheck(COMPANY_A, PERIOD);

    // call 0 is this period's postings.
    const template = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    const q = template.join('?');
    expect(q).toContain('gl_journal_lines');
    expect(q).toContain('gl_journal_entries');
  });

  it('company_id is first interpolated arg', async () => {
    prime({ debit: '0', credit: '0' }, []);
    await tbBalancedCheck(COMPANY_A, PERIOD);
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
  });

  /**
   * The income-statement half of the trial balance is measured from the registry
   * year holding the period, so this close path has no assumed year start to
   * refuse: it never reads `companies.financial_year_start`.
   */
  it('never reads the declared financial year start', async () => {
    prime({ debit: '10000.00', credit: '10000.00' }, balancedTb);
    await tbBalancedCheck(COMPANY_A, PERIOD);
    const texts = mockSql.mock.calls.map((c) => (c[0] as TemplateStringsArray).join('?'));
    expect(texts.some((t) => t.includes('financial_year_start'))).toBe(false);
  });

  it('measures from the registry year, whatever month the company declared', async () => {
    fakeRegistry.years = [{ fiscalYear: 2026, startDate: '2025-12-01', endDate: '2026-11-30' }];
    prime({ debit: '10000.00', credit: '10000.00' }, balancedTb);
    expect((await tbBalancedCheck(COMPANY_A, PERIOD)).status).toBe('pass');
    // The balance query is bounded below by the registry year's start (1 Dec 2025).
    expect(mockSql.mock.calls[2]!.slice(1)).toContain('2025-12-01');
  });
});

// ── vatReviewedCheck ─────────────────────────────────────────────────────────

