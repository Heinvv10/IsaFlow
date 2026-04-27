/**
 * Unit tests for periodCloseReadinessService
 *
 * Covers:
 * 1. Each of the 6 checks returns a sensible status when SQL returns appropriate data.
 * 2. company_id is the first interpolated arg in EVERY SQL call.
 * 3. Cross-tenant: different companyId produces different results.
 * 4. overallStatus aggregation: all-pass → pass; one warn → warn; one fail → fail.
 * 5. Sub-ledger tolerance: diff ≤ 0.01 → pass; diff > 0.01 → not pass.
 * 6. getCloseReadiness returns null when period not found.
 *
 * IMPORTANT — Promise.all execution order
 * All 6 check functions start concurrently. Each runs until its first await, then
 * yields. The mock calls therefore arrive in this order:
 *   1. bank_reconciled  (1 call)
 *   2. unposted_journals (1 call)
 *   3. ar_ties          (call 1: invoice sum)
 *   4. ap_ties          (call 1: invoice total)
 *   5. vat_reviewed     (1 call)
 *   6. tb_balanced      (1 call)
 *   7. ar_ties          (call 2: GL balance — second await)
 *   8. ap_ties          (call 2: GL balance — second await)
 */

import { describe, it, expect, vi, beforeEach, type MockedFunction } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodById: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { getFiscalPeriodById } from '@/modules/accounting/services/gl/fiscalPeriodService';
import { getCloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';

type SqlFn = MockedFunction<(...args: unknown[]) => Promise<unknown[]>>;
type GetPeriodFn = MockedFunction<(companyId: string, id: string) => Promise<FiscalPeriod | null>>;

const mockSql = sql as unknown as SqlFn;
const mockGetPeriodById = getFiscalPeriodById as GetPeriodFn;

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
 * Sets up mocks for all 6 SQL checks in actual Promise.all execution order:
 *  Call 1: bank_reconciled     (COUNT unreconciled)
 *  Call 2: unposted_journals   (COUNT draft)
 *  Call 3: ar_ties             (invoice sum — first await)
 *  Call 4: ap_ties             (invoice total — first await)
 *  Call 5: vat_reviewed        (COUNT vat_returns)
 *  Call 6: tb_balanced         (SUM debit/credit)
 *  Call 7: ar_ties             (GL balance — second await)
 *  Call 8: ap_ties             (GL balance — second await)
 */
function mockAllChecksPass(): void {
  mockSql
    .mockResolvedValueOnce([{ unreconciled_count: '0' }])          // 1: bank
    .mockResolvedValueOnce([{ draft_count: '0' }])                  // 2: journals
    .mockResolvedValueOnce([{ ar_total: '1000.00' }])               // 3: AR invoice sum
    .mockResolvedValueOnce([{ ap_total: '500.00' }])                // 4: AP invoice sum
    .mockResolvedValueOnce([{ vat_count: '1' }])                    // 5: VAT
    .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }]) // 6: TB
    .mockResolvedValueOnce([{ gl_balance: '1000.00' }])             // 7: AR GL balance
    .mockResolvedValueOnce([{ gl_balance: '500.00' }]);             // 8: AP GL balance
}

describe('getCloseReadiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(result!.items).toHaveLength(6);
    for (const item of result!.items) {
      expect(item.status).toBe('pass');
    }
  });

  // ── overallStatus aggregation ─────────────────────────────────────────────

  it('overallStatus is warn when at least one item is warn and none fail', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])         // bank: pass
      .mockResolvedValueOnce([{ draft_count: '0' }])                // journals: pass
      .mockResolvedValueOnce([{ ar_total: '1000.00' }])             // AR invoice sum
      .mockResolvedValueOnce([{ ap_total: '500.00' }])              // AP invoice sum
      .mockResolvedValueOnce([{ vat_count: '0' }])                  // VAT: WARN
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }]) // TB: pass
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }])           // AR GL: pass
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);           // AP GL: pass

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result!.overallStatus).toBe('warn');
    const vatItem = result!.items.find(i => i.key === 'vat_reviewed');
    expect(vatItem!.status).toBe('warn');
  });

  it('overallStatus is fail when at least one item fails', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '3' }])         // bank: FAIL
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '1000.00' }])
      .mockResolvedValueOnce([{ ap_total: '500.00' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    expect(result!.overallStatus).toBe('fail');
    const bankItem = result!.items.find(i => i.key === 'bank_reconciled');
    expect(bankItem!.status).toBe('fail');
  });

  // ── Sub-ledger tolerance ─────────────────────────────────────────────────

  it('AR ties passes when difference is exactly at tolerance boundary (0.01)', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '1000.01' }])             // AR invoice sum
      .mockResolvedValueOnce([{ ap_total: '500.00' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }])           // AR GL — diff = 0.01
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);
    const arItem = result!.items.find(i => i.key === 'ar_ties');
    expect(arItem!.status).toBe('pass');
  });

  it('AR ties is not pass when difference exceeds tolerance (0.5)', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '1000.50' }])             // AR invoice sum
      .mockResolvedValueOnce([{ ap_total: '500.00' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }])           // AR GL — diff = 0.50
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);
    const arItem = result!.items.find(i => i.key === 'ar_ties');
    expect(arItem!.status).not.toBe('pass');
  });

  it('AR ties passes when sub-ledger differs by 0.005 (within tolerance)', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '1000.005' }])            // AR invoice sum
      .mockResolvedValueOnce([{ ap_total: '500.00' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '10000.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '1000.00' }])           // AR GL — diff = 0.005
      .mockResolvedValueOnce([{ gl_balance: '500.00' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);
    const arItem = result!.items.find(i => i.key === 'ar_ties');
    expect(arItem!.status).toBe('pass');
  });

  // ── company_id in first SQL arg ───────────────────────────────────────────

  it('passes company_id as first interpolated arg in every SQL call', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockAllChecksPass();

    await getCloseReadiness(COMPANY_A, PERIOD_ID);

    // 8 SQL calls total (1+1+1+1+1+1+1+1)
    expect(mockSql).toHaveBeenCalledTimes(8);

    for (const call of mockSql.mock.calls) {
      // sql tagged template: call[0] is TemplateStringsArray, call[1] is first interpolated value
      const firstArg = call[1] as string;
      expect(firstArg).toBe(COMPANY_A);
    }
  });

  // ── Cross-tenant isolation ────────────────────────────────────────────────

  it('uses different company_id for each tenant — results differ (cross-tenant)', async () => {
    // Company A — 3 unreconciled bank txns → fail
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '3' }])
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '0' }])
      .mockResolvedValueOnce([{ ap_total: '0' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);

    const resultA = await getCloseReadiness(COMPANY_A, PERIOD_ID);

    vi.clearAllMocks();

    // Company B — 0 unreconciled bank txns → pass
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());
    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '0' }])
      .mockResolvedValueOnce([{ ap_total: '0' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);

    const resultB = await getCloseReadiness(COMPANY_B, PERIOD_ID);

    const bankA = resultA!.items.find(i => i.key === 'bank_reconciled');
    const bankB = resultB!.items.find(i => i.key === 'bank_reconciled');

    expect(bankA!.status).toBe('fail');
    expect(bankB!.status).toBe('pass');

    // Confirm second run's SQL calls use COMPANY_B
    expect(mockSql.mock.calls[0]![1]).toBe(COMPANY_B);
  });

  // ── Individual check behaviour ────────────────────────────────────────────

  it('unposted_journals check fails with correct count in reason', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])
      .mockResolvedValueOnce([{ draft_count: '5' }])               // 5 draft journals
      .mockResolvedValueOnce([{ ar_total: '0' }])
      .mockResolvedValueOnce([{ ap_total: '0' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      .mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);
    const item = result!.items.find(i => i.key === 'unposted_journals');

    expect(item!.status).toBe('fail');
    expect(item!.reason).toContain('5');
    expect(item!.fixHref).toBe('/accounting/journal-entries?filter=draft');
  });

  it('tb_balanced check fails when debits != credits', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '0' }])
      .mockResolvedValueOnce([{ ap_total: '0' }])
      .mockResolvedValueOnce([{ vat_count: '1' }])
      // TB unbalanced — 200 difference
      .mockResolvedValueOnce([{ total_debit: '10200.00', total_credit: '10000.00' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);
    const item = result!.items.find(i => i.key === 'tb_balanced');

    expect(item!.status).toBe('fail');
    expect(item!.fixHref).toBe('/accounting/trial-balance');
  });

  it('vat_reviewed check warns (not fails) when no VAT return exists', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '0' }])
      .mockResolvedValueOnce([{ draft_count: '0' }])
      .mockResolvedValueOnce([{ ar_total: '0' }])
      .mockResolvedValueOnce([{ ap_total: '0' }])
      .mockResolvedValueOnce([{ vat_count: '0' }])                  // no VAT return → warn
      .mockResolvedValueOnce([{ total_debit: '0', total_credit: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }])
      .mockResolvedValueOnce([{ gl_balance: '0' }]);

    const result = await getCloseReadiness(COMPANY_A, PERIOD_ID);
    const item = result!.items.find(i => i.key === 'vat_reviewed');

    expect(item!.status).toBe('warn');
    // All other items pass → overallStatus should be warn (not fail)
    expect(result!.overallStatus).toBe('warn');
  });

  // ── Fix-link routes ───────────────────────────────────────────────────────

  it('returns correct fix-link hrefs for each check when not passing', async () => {
    mockGetPeriodById.mockResolvedValueOnce(makePeriod());

    mockSql
      .mockResolvedValueOnce([{ unreconciled_count: '1' }])         // bank: fail
      .mockResolvedValueOnce([{ draft_count: '1' }])               // journals: fail
      .mockResolvedValueOnce([{ ar_total: '1000' }])               // AR invoice sum
      .mockResolvedValueOnce([{ ap_total: '1000' }])               // AP invoice sum
      .mockResolvedValueOnce([{ vat_count: '0' }])                 // VAT: warn
      .mockResolvedValueOnce([{ total_debit: '10200', total_credit: '10000' }]) // TB: fail
      .mockResolvedValueOnce([{ gl_balance: '500' }])              // AR GL — large diff → fail
      .mockResolvedValueOnce([{ gl_balance: '500' }]);             // AP GL — large diff → fail

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
