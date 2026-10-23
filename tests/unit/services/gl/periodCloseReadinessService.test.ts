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
import { mockUnsafe } from '../../helpers/sqlFragmentMock';
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

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
type GetPeriodFn = MockedFunction<(companyId: string, id: string) => Promise<FiscalPeriod | null>>;

const mockSql = sql as unknown as SqlFn;
const mockGetPeriodById = getFiscalPeriodById as GetPeriodFn;
const mockReconcile = vi.mocked(reconcileSubledger);

/** A reconciliation where the subledger ties to the control account exactly. */
function tiedReconciliation(role: string, asAt: string): SubledgerReconciliation {
  return {
    subledger: role as SubledgerReconciliation['subledger'],
    as_at: asAt,
    agedTotal: 1000,
    subledgerTotal: 1000,
    subledgerUnavailable: null,
    controlAccounts: [],
    controlAccountBalance: 1000,
    controlAccountAmbiguous: false,
    difference: 0,
    reconcilingItems: [],
    unexplainedDifference: 0,
    excludedRows: [],
    settlementFlagged: {} as SubledgerReconciliation['settlementFlagged'],
    invariants: [],
    postedThrough: null,
  };
}

const COMPANY_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const COMPANY_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const PERIOD_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

function makePeriod(overrides: Partial<FiscalPeriod> = {}): FiscalPeriod {
  return {
    id: PERIOD_ID,
    periodName: 'January 2026',
    periodNumber: 1,
    fiscalYear: 2026,
    startDate: '2026-01-01',
    endDate: '2026-01-31',
    status: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

/**
 * Sets up mocks for the SQL checks in SEQUENTIAL execution order. The checks
 * run one-at-a-time (each inside its own savepoint). The ar/ap ties issue no
 * direct SQL — they call the (mocked) reconcileSubledger — so the order is:
 *  Call 1: bank       (1 query)
 *  Call 2: journals   (1 query)
 *  Call 3: vat        (1 query)
 *  Call 4-7: tb — this period's postings, then getTrialBalanceReport's
 *             period basis, balances and brought-forward profit (4 queries;
 *             its fiscal years come from the mocked registry, not sql)
 *  Call 8: opening balance equity (1 query)
 *  Call 9: orphan period journals (1 query)
 */
function mockAllChecksPass(): void {
  mockSql
    .mockResolvedValueOnce([{ unreconciled_count: '0' }])  // bank
    .mockResolvedValueOnce([{ draft_count: '0' }])         // journals
    .mockResolvedValueOnce([{ vat_count: '1' }])           // vat
    // tb — this period's postings, then the report itself
    .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
    .mockResolvedValueOnce([{ start_date: '2026-02-01', end_date: '2026-02-28' }])
    .mockResolvedValueOnce([
      { account_code: '1000', account_name: 'Bank', account_type: 'asset', normal_balance: 'debit',
        closing_debit: '10000.00', closing_credit: '0', period_debit: '10000.00', period_credit: '0' },
      { account_code: '2001', account_name: 'Creditors', account_type: 'liability', normal_balance: 'credit',
        closing_debit: '0', closing_credit: '10000.00', period_debit: '0', period_credit: '10000.00' },
    ])
    .mockResolvedValueOnce([{ retained: '0' }])
    .mockResolvedValueOnce([{ accounts: '0', balance: '0' }]) // opening balance equity
    .mockResolvedValueOnce([{ orphan_count: '0', earliest: null, latest: null, total: '0' }])
}

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
      .mockResolvedValueOnce([{ vat_count: '0' }])         // VAT: WARN
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
      const args = (call as unknown[]).slice(1);
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

    expect(byKey['bank_reconciled']!.fixHref).toBe('/accounting/bank-transactions');
    expect(byKey['unposted_journals']!.fixHref).toContain('/accounting/journal-entries');
    expect(byKey['ar_ties']!.fixHref).toContain('/accounting/customer-invoices');
    expect(byKey['ap_ties']!.fixHref).toContain('/accounting/supplier-invoices');
    expect(byKey['vat_reviewed']!.fixHref).toContain('/accounting/reports/vat-return');
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

describe('bankReconciledCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { startDate: '2026-01-01', endDate: '2026-01-31' };

  it('passes when no imported/matched transactions', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '0' }]);
    const item = await bankReconciledCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('fails when imported/matched transactions exist', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '5' }]);
    const item = await bankReconciledCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('5');
  });

  it('SQL filters status IN imported/matched — does NOT use NOT IN', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '0' }]);
    await bankReconciledCheck(COMPANY_A, PERIOD);

    const call = mockSql.mock.calls[0]!;
    const template = call[0] as TemplateStringsArray;
    const fullQuery = template.join('?');
    // Must use positive IN filter, not NOT IN
    expect(fullQuery).toContain("status IN ('imported', 'matched')");
    expect(fullQuery).not.toContain('NOT IN');
  });

  it('SQL references bank_transactions table', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '0' }]);
    await bankReconciledCheck(COMPANY_A, PERIOD);

    const template = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    expect(template.join('?')).toContain('bank_transactions');
  });

  it('company_id is first interpolated arg', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '0' }]);
    await bankReconciledCheck(COMPANY_A, PERIOD);
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
  });
});

// ── unpostedJournalsCheck ─────────────────────────────────────────────────────

describe('unpostedJournalsCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { id: PERIOD_ID };

  it('passes when all journals are posted', async () => {
    mockSql.mockResolvedValueOnce([{ draft_count: '0' }]);
    const item = await unpostedJournalsCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('fails with count in reason when draft journals exist', async () => {
    mockSql.mockResolvedValueOnce([{ draft_count: '5' }]);
    const item = await unpostedJournalsCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('fail');
    expect(item.reason).toContain('5');
    expect(item.fixHref).toBe('/accounting/journal-entries?filter=draft');
  });

  it('SQL references gl_journal_entries', async () => {
    mockSql.mockResolvedValueOnce([{ draft_count: '0' }]);
    await unpostedJournalsCheck(COMPANY_A, PERIOD);

    const template = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    expect(template.join('?')).toContain('gl_journal_entries');
  });

  it('company_id is first interpolated arg', async () => {
    mockSql.mockResolvedValueOnce([{ draft_count: '0' }]);
    await unpostedJournalsCheck(COMPANY_A, PERIOD);
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
  });
});

// ── tbBalancedCheck ───────────────────────────────────────────────────────────

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

describe('vatReviewedCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { startDate: '2026-01-01', endDate: '2026-01-31' };

  it('passes when a VAT return exists for this period', async () => {
    mockSql.mockResolvedValueOnce([{ vat_count: '1' }]);
    const item = await vatReviewedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('warns (not fails) when no VAT return exists', async () => {
    mockSql.mockResolvedValueOnce([{ vat_count: '0' }]);
    const item = await vatReviewedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('warn');
  });

  it('SQL references vat_returns table', async () => {
    mockSql.mockResolvedValueOnce([{ vat_count: '0' }]);
    await vatReviewedCheck(COMPANY_A, PERIOD);

    const template = mockSql.mock.calls[0]![0] as TemplateStringsArray;
    expect(template.join('?')).toContain('vat_returns');
  });

  it('company_id is first interpolated arg', async () => {
    mockSql.mockResolvedValueOnce([{ vat_count: '0' }]);
    await vatReviewedCheck(COMPANY_A, PERIOD);
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_A);
  });
});
