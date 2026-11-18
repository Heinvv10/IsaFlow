/**
 * The bank, journals and VAT readiness checks.
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

  it('SQL counts the shared unreconciled-line predicate, not a hand-written status list (Hein 2026-11-15)', async () => {
    mockSql.mockResolvedValueOnce([{ unreconciled_count: '0' }]);
    await bankReconciledCheck(COMPANY_A, PERIOD);

    const call = mockSql.mock.calls[0]!;
    const fullQuery = (call[0] as TemplateStringsArray).join('?');
    // imported/matched only let a period of allocated-but-unreconciled lines pass; the rule is bank/unreconciledLineSql.
    expect(call.slice(1).some((v) => v instanceof MockSqlFragment && v.text === UNRECONCILED_LINE_SQL)).toBe(true);
    expect(fullQuery).not.toMatch(/status IN/);
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


describe('vatReviewedCheck', () => {
  beforeEach(() => vi.clearAllMocks());

  const PERIOD = { startDate: '2026-01-01', endDate: '2026-01-31' };

  const FILING = { source: 'lifecycle', company_id: COMPANY_A, period_start: '2026-01-01', period_end: '2026-02-28',
    status: 'finalised', output_tax: '150', input_tax: '60', net_vat: '90' };

  it('passes when a VAT201 filing overlaps this period', async () => {
    mockSql.mockResolvedValueOnce([FILING]);
    const item = await vatReviewedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('pass');
  });

  it('warns (not fails) when no VAT201 filing exists', async () => {
    mockSql.mockResolvedValueOnce([]);
    const item = await vatReviewedCheck(COMPANY_A, PERIOD);
    expect(item.status).toBe('warn');
  });

  it('reads the lifecycle with vat_returns as the fallback (vatPeriodFilings)', async () => {
    mockSql.mockResolvedValueOnce([]);
    await vatReviewedCheck(COMPANY_A, PERIOD);

    const template = (mockSql.mock.calls[0]![0] as TemplateStringsArray).join('?');
    expect(template).toContain('tax_return_versions');
    expect(template).toContain('vat_returns');
  });

  it('scopes to the company: [companyId] is the first interpolated arg', async () => {
    mockSql.mockResolvedValueOnce([]);
    await vatReviewedCheck(COMPANY_A, PERIOD);
    expect(mockSql.mock.calls[0]![1]).toEqual([COMPANY_A]);
  });
});
