/**
 * getCloseReadiness: per-check savepoints, failure isolation, fix links, period label.
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

describe('getCloseReadiness — orchestrator (isolation)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReconcile.mockImplementation(async (_c, role, asAt) => tiedReconciliation(role, asAt));
  });
  // ── Per-check savepoint isolation (poisoned-tx protection) ────────────────

  it('runs each readiness check inside its own savepoint so an errored check cannot poison the caller tx', async () => {
    // getCloseReadiness is called inside startCloseRun's request tx, which then
    // WRITES (abandon/insert). A DB-level error in any check must roll back to a
    // savepoint instead of poisoning the shared tx and 500-ing those writes.
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockAllChecksPass();

    await getCloseReadiness(COMPANY_A, PERIOD_ID);

    const mockWithSavepoint = withSavepoint as unknown as MockedFunction<
      (name: string, fn: () => Promise<unknown>) => Promise<unknown>
    >;
    // one orchestrator savepoint per check — eight checks. The ar/ap ties
    // also open one NESTED savepoint each around reconcileSubledger.
    const names = mockWithSavepoint.mock.calls.map((c) => String(c[0]));
    expect(names.filter((n) => n.startsWith('close_check_'))).toHaveLength(8);
    expect(names.filter((n) => n.endsWith('_tie_recon'))).toEqual(['ar_tie_recon', 'ap_tie_recon']);
    // every savepoint name is a valid identifier (withSavepoint rejects bad names at runtime)
    for (const call of mockWithSavepoint.mock.calls) {
      expect(String(call[0])).toMatch(/^[a-zA-Z_][a-zA-Z0-9_]{0,30}$/);
    }
  });

  it('runs the checks strictly sequentially — never two savepoints open at once (LIFO-safe on one connection)', async () => {
    // The fix depends on SEQUENCING: concurrent savepoints on the single request
    // connection corrupt the savepoint stack (releasing an earlier savepoint
    // destroys later ones). Guard against a regression back to Promise.allSettled
    // by proving at most one check's savepoint is open at any instant.
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    let openDepth = 0;
    let maxDepth = 0;
    const mockWithSavepoint = withSavepoint as unknown as MockedFunction<
      (name: string, fn: () => Promise<unknown>) => Promise<unknown>
    >;
    mockWithSavepoint.mockImplementation(async (name, fn) => {
      // Only the orchestrator's per-check savepoints count: a check may nest
      // its own savepoint inside (LIFO-safe), but two checks may never overlap.
      const top = name.startsWith('close_check_');
      if (top) {
        openDepth++;
        maxDepth = Math.max(maxDepth, openDepth);
      }
      try {
        return await fn();
      } finally {
        if (top) openDepth--;
      }
    });
    // Real async work per query so a concurrent orchestrator WOULD overlap here.
    mockSql.mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([{}]), 0)));

    try {
      await getCloseReadiness(COMPANY_A, PERIOD_ID);
      expect(maxDepth).toBe(1);
    } finally {
      // Restore the pass-through default in a finally so a failed assertion can't
      // leak the async savepoint impl into later tests (beforeEach's
      // vi.clearAllMocks clears call history, NOT implementations).
      mockWithSavepoint.mockImplementation((_name, fn) => fn());
      mockSql.mockReset();
    }
  });

  // ── One-check-failure isolation ──────────────────────────────────────────

  it('one check throwing → others still report normally; failing check shows warn', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    // bank check throws; everything else passes
    mockSql
      .mockRejectedValueOnce(new Error('DB timeout'))  // bank check: THROWS
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ accounts: '0', balance: '0' }]) // opening balance equity

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result).not.toBeNull();
    expect(result!.items).toHaveLength(8);

    const bankItem = result!.items.find(i => i.key === 'bank_reconciled');
    expect(bankItem!.status).toBe('warn');
    expect(bankItem!.reason).toContain('Could not compute');

    // Other checks should still pass
    const journalItem = result!.items.find(i => i.key === 'unposted_journals');
    expect(journalItem!.status).toBe('pass');

    // Error should be logged
    const mockLog = log as { error: MockedFunction<(...args: unknown[]) => void> };
    expect(mockLog.error).toHaveBeenCalledWith(
      'close-readiness check failed',
      expect.objectContaining({ checkIndex: 0 }),
      'accounting',
    );
  });

  it('AP check failing does not blank other items', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockReconcile.mockImplementation(async (_c, role, asAt) => {
      if (role === 'ap') throw new Error('AP table unavailable');
      return tiedReconciliation(role, asAt);
    });

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])  // bank: pass
      .mockResolvedValueOnce([{ draft_count: '0' }])           // journals: pass
      .mockResolvedValueOnce([{ vat_count: '1' }])             // vat: pass
      // tb: pass — period postings, then the report
      .mockResolvedValueOnce([{ total_debit: '1000.00', total_credit: '1000.00' }])
      .mockResolvedValueOnce([{ start_date: '2026-02-01', end_date: '2026-02-28' }])
      .mockResolvedValueOnce([
        { account_code: '1000', account_name: 'Bank', account_type: 'asset', normal_balance: 'debit',
          closing_debit: '1000.00', closing_credit: '0', period_debit: '1000.00', period_credit: '0' },
        { account_code: '2001', account_name: 'Creditors', account_type: 'liability', normal_balance: 'credit',
          closing_debit: '0', closing_credit: '1000.00', period_debit: '0', period_credit: '1000.00' },
      ])
      .mockResolvedValueOnce([{ retained: '0' }])
      .mockResolvedValueOnce([{ accounts: '0', balance: '0' }]) // opening balance equity

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    const apItem = result!.items.find(i => i.key === 'ap_ties');
    expect(apItem!.status).toBe('warn');
    expect(apItem!.reason).toMatch(/^Could not compute/);
    expect(result!.items.find(i => i.key === 'ar_ties')!.status).toBe('pass');

    const bankItem = result!.items.find(i => i.key === 'bank_reconciled');
    expect(bankItem!.status).toBe('pass');

    const tbItem = result!.items.find(i => i.key === 'tb_balanced');
    expect(tbItem!.status).toBe('pass');
  });

  // ── Fix-link routes ───────────────────────────────────────────────────────

  it('returns correct fix-link hrefs for each check when not passing', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '1' }])   // bank
      .mockResolvedValueOnce([{ draft_count: '1' }])          // journals
      .mockResolvedValueOnce([{ vat_count: '0' }])            // vat
      .mockResolvedValueOnce([{ total_debit: '10200', total_credit: '10000' }]) // tb
      .mockResolvedValueOnce([{ accounts: '0', balance: '0' }]) // opening balance equity

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);
    const byKey = Object.fromEntries(result!.items.map(i => [i.key, i]));

    expect(byKey['bank_reconciled']!.fixHref).toBe('/accounting/bank-reconciliation');
    expect(byKey['unposted_journals']!.fixHref).toContain('/accounting/journal-entries');
    expect(byKey['ar_ties']!.fixHref).toContain('/accounting/customer-invoices');
    expect(byKey['ap_ties']!.fixHref).toContain('/accounting/supplier-invoices');
    expect(byKey['vat_reviewed']!.fixHref).toContain('/accounting/sars/vat201');
    expect(byKey['tb_balanced']!.fixHref).toContain('/accounting/trial-balance');
  });

  // ── Period label ─────────────────────────────────────────────────────────

  it('returns the period label and id from the fiscal period record', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod({ periodName: 'March 2026' }));
    mockAllChecksPass();

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result!.periodLabel).toBe('March 2026');
    expect(result!.periodId).toBe(PERIOD_ID);
  });
});

// ── bankReconciledCheck ───────────────────────────────────────────────────────

