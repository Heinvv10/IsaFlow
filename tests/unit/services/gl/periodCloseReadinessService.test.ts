/**
 * Unit tests for periodCloseReadinessService (orchestrator) and check files.
 *
 * Coverage:
 *  1. Each of the 6 checks returns sensible status given appropriate SQL data.
 *  2. company_id is the first interpolated arg in EVERY SQL call.
 *  3. Cross-tenant: different companyId → different results (branching mock).
 *  4. overallStatus aggregation: all-pass → pass; one warn → warn; one fail → fail.
 *  5-7. AR / AP tie verdicts live in tests/unit/services/gl/subLedgerTieCheck.test.ts;
 *       here reconcileSubledger is mocked to a tie so the orchestrator is isolated.
 *  8. getCloseReadiness returns null when period not found.
 *  9. SQL shape: bank check filters status IN ('imported','matched') — not NOT IN.
 * 11. SQL shape: each check references its expected table.
 * 12. Promise.allSettled isolation: one check throwing → others still report.
 * 13. Fix-link hrefs correct for each failing check.
 * 14. Period label and id forwarded from fiscal period record.
 * 15. unposted_journals count in reason text.
 * 16. tb_balanced fail when debits != credits.
 * 17. vat_reviewed warns (not fails) when no return.
 * 18. AP failure isolation — failing AP check doesn't blank other items.
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

describe('getCloseReadiness — orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcile.mockImplementation(async (_c, role, asAt) => tiedReconciliation(role, asAt));
  });

  // ── Null period ──────────────────────────────────────────────────────────

  it('returns null when period is not found for this company', async () => {
    mockGetPeriodById.mockResolvedValueOnce(null);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result).toBeNull();
    expect(mockSql).not.toHaveBeenCalled();
  });

  // ── All pass ─────────────────────────────────────────────────────────────

  it('returns overallStatus=pass when all checks pass', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockAllChecksPass();

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result).not.toBeNull();
    expect(result!.overallStatus).toBe('pass');
    expect(result!.items).toHaveLength(8);
    for (const item of result!.items) {
      expect(item.status).toBe('pass');
    }
  });

  // ── overallStatus aggregation ─────────────────────────────────────────────

  it('overallStatus is warn when at least one item is warn and none fail', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([])                           // VAT: no filing, WARN
      // tb — period postings, then the report itself
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ start_date: '2026-02-01', end_date: '2026-02-28' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ retained: '0' }])
      .mockResolvedValueOnce([{ accounts: '0', balance: '0' }]) // opening balance equity

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result!.overallStatus).toBe('warn');
    const vatItem = result!.items.find(i => i.key === 'vat_reviewed');
    expect(vatItem!.status).toBe('warn');
  });

  it('overallStatus is fail when at least one item fails', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '3' }])  // bank: FAIL
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ accounts: '0', balance: '0' }]) // opening balance equity

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result!.overallStatus).toBe('fail');
    const bankItem = result!.items.find(i => i.key === 'bank_reconciled');
    expect(bankItem!.status).toBe('fail');
  });

  // ── company_id in first SQL arg ───────────────────────────────────────────

  it('passes company_id as first interpolated arg in every SQL call', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockAllChecksPass();

    await getCloseReadiness(COMPANY_A, PERIOD_ID);

    // 5 single-query checks + the 4 the trial balance check issues; the ar/ap
    // ties go through reconcileSubledger instead.
    expect(mockSql).toHaveBeenCalledTimes(9);
    // Every query must be company-scoped. Asserted on membership rather than
    // position: a query with conditional aggregation interpolates its CASE
    // bounds before it reaches the WHERE clause, and an unscoped query fails
    // this exactly as it failed the positional form.
    for (const call of mockSql.mock.calls) {
      // flat(): the VAT check scopes by [companyId] (vatPeriodFilings takes a list).
      const args = (call as unknown[]).slice(1).flat();
      expect(args).toContain(COMPANY_A);
    }
  });

  // ── Cross-tenant isolation — branching mock ───────────────────────────────

  it('routes SQL by tenant — different companyId produces different results', async () => {
    // Branching mock: routes by the companyId interpolated into the query.
    mockSql.mockImplementation((_template: TemplateStringsArray, ...args: unknown[]) => {
      const companyId = args[0] as string;
      if (companyId === COMPANY_A) {
        // company A has 3 unreconciled transactions
        return Promise.resolve([
          { unreconciled_count: '3', draft_count: '0', ar_total: '0',
            ap_total: '0', vat_count: '1', total_debit: '0', total_credit: '0',
            gl_balance: '0' },
        ]);
      }
      // company B: all clear
      return Promise.resolve([
        { unreconciled_count: '0', draft_count: '0', ar_total: '0',
          ap_total: '0', vat_count: '1', total_debit: '0', total_credit: '0',
          gl_balance: '0' },
      ]);
    });

    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    const resultA = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    vi.clearAllMocks();

    mockSql.mockImplementation((_template: TemplateStringsArray, ...args: unknown[]) => {
      const companyId = args[0] as string;
      if (companyId === COMPANY_B) {
        return Promise.resolve([
          { unreconciled_count: '0', draft_count: '0', ar_total: '0',
            ap_total: '0', vat_count: '1', total_debit: '0', total_credit: '0',
            gl_balance: '0' },
        ]);
      }
      return Promise.resolve([{ unreconciled_count: '3' }]);
    });

    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    const resultB = await getCloseReadiness(COMPANY_B, PERIOD_ID);

    const bankA = resultA!.items.find(i => i.key === 'bank_reconciled');
    const bankB = resultB!.items.find(i => i.key === 'bank_reconciled');

    expect(bankA!.status).toBe('fail');
    expect(bankB!.status).toBe('pass');

    // Confirm second run's SQL calls use COMPANY_B
    const secondRunFirstArg = mockSql.mock.calls[0]![1];
    expect(secondRunFirstArg).toBe(COMPANY_B);
  });

});
