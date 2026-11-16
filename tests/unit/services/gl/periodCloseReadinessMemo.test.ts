/**
 * Q7 (2026-11-15): `orphan_period_journals` reads the whole company, so a
 * request that judges many periods (Bulk Close, Close Year, the year-end lock)
 * runs it once through a CloseCheckMemo, not once per period. Without a memo
 * (the checklist panel, one period) it runs every time.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pass } = vi.hoisted(() => ({
  pass: (key: string) => async () => ({ key, label: key, status: 'pass', reason: 'ok', fixHref: '/' }),
}));
vi.mock('@/lib/neon', () => ({ withSavepoint: vi.fn((_n: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  getFiscalPeriodById: vi.fn(async (_c: string, id: string) => ({ id, periodName: id, startDate: '2026-01-01', endDate: '2026-01-31' })),
}));
vi.mock('@/modules/accounting/services/gl/closeReadinessChecks/bankReconciledCheck', async (orig) => ({
  ...(await orig<object>()), bankReconciledCheck: vi.fn(pass('bank_reconciled')),
}));
vi.mock('@/modules/accounting/services/gl/closeReadinessChecks/unpostedJournalsCheck', () => ({ unpostedJournalsCheck: vi.fn(pass('unposted_journals')) }));
vi.mock('@/modules/accounting/services/gl/closeReadinessChecks/arSubLedgerCheck', () => ({ arSubLedgerCheck: vi.fn(pass('ar_ties')) }));
vi.mock('@/modules/accounting/services/gl/closeReadinessChecks/apSubLedgerCheck', () => ({ apSubLedgerCheck: vi.fn(pass('ap_ties')) }));
vi.mock('@/modules/accounting/services/gl/closeReadinessChecks/vatReviewedCheck', () => ({ vatReviewedCheck: vi.fn(pass('vat_reviewed')) }));
vi.mock('@/modules/accounting/services/gl/closeReadinessChecks/tbBalancedCheck', () => ({ tbBalancedCheck: vi.fn(pass('tb_balanced')) }));
vi.mock('@/modules/accounting/services/gl/closeReadinessChecks/openingBalanceEquityCheck', () => ({ openingBalanceEquityCheck: vi.fn(pass('opening_balance_cleared')) }));
vi.mock('@/modules/accounting/services/gl/closeReadinessChecks/orphanPeriodJournalsCheck', () => ({ orphanPeriodJournalsCheck: vi.fn(pass('orphan_period_journals')) }));

import { orphanPeriodJournalsCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/orphanPeriodJournalsCheck';
import { BANK_RECONCILED_FIX_HREF, bankReconciledCheck } from '@/modules/accounting/services/gl/closeReadinessChecks/bankReconciledCheck';
import { getCloseReadiness, type CloseCheckMemo } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import { runInPeriodLockBudget } from '@/modules/accounting/services/gl/periodLockBudgetScope';

beforeEach(() => { vi.clearAllMocks(); });

describe('getCloseReadiness with a CloseCheckMemo', () => {
  it('runs the company-wide check once for many periods, and every period-scoped check per period', async () => {
    const memo: CloseCheckMemo = {};
    const a = await getCloseReadiness('co', 'p1', memo);
    const b = await getCloseReadiness('co', 'p2', memo);
    expect(orphanPeriodJournalsCheck).toHaveBeenCalledTimes(1);
    expect(bankReconciledCheck).toHaveBeenCalledTimes(2);
    expect(b!.items.at(-1)).toEqual(a!.items.at(-1));
    expect(b!.items.map((i) => i.key)).toContain('orphan_period_journals');
  });

  it.each([['55P03'], ['40P01']])('3b, inside a lock budget (a close): a check that hit a busy row (%s) is rethrown', async (code) => {
    const busy = Object.assign(new Error('lock timeout'), { code });
    vi.mocked(bankReconciledCheck).mockRejectedValueOnce(busy);
    await expect(runInPeriodLockBudget(() => getCloseReadiness('co', 'p1'))).rejects.toBe(busy);
  });

  it.each([['55P03'], ['40P01']])('F, advisory (no lock budget: the panel, MCP checklist, close run): a busy check (%s) is ONE busy row, the rest still come back', async (code) => {
    vi.mocked(bankReconciledCheck).mockRejectedValueOnce(Object.assign(new Error('deadlock detected'), { code }));
    const r = await getCloseReadiness('co', 'p1');
    expect(r!.items).toHaveLength(8);
    expect(r!.items[0]).toMatchObject({ key: 'bank_reconciled', status: 'warn', reason: expect.stringMatching(/^Could not compute — busy: .*retry/) });
    expect(r!.items.slice(1).every((i) => i.status === 'pass')).toBe(true);
  });

  it('a check that failed for any other reason still degrades to "Could not compute" (which blocks a close)', async () => {
    vi.mocked(bankReconciledCheck).mockRejectedValueOnce(Object.assign(new Error('relation does not exist'), { code: '42P01' }));
    const r = await getCloseReadiness('co', 'p1');
    expect(r!.items[0]).toMatchObject({ key: 'bank_reconciled', status: 'warn', reason: expect.stringMatching(/^Could not compute/) });
  });

  it('without a memo it runs every time', async () => {
    await getCloseReadiness('co', 'p1');
    await getCloseReadiness('co', 'p2');
    expect(orphanPeriodJournalsCheck).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['busy (40P01)', Object.assign(new Error('deadlock detected'), { code: '40P01' })],
    ['could not compute (42P01)', Object.assign(new Error('relation does not exist'), { code: '42P01' })],
  ])('H: the %s bank row links where the check\'s own pass / fail rows do (bank reconciliation, since #1442)', async (_n, err) => {
    vi.mocked(bankReconciledCheck).mockRejectedValueOnce(err);
    const r = await getCloseReadiness('co', 'p1');
    expect(BANK_RECONCILED_FIX_HREF).toBe('/accounting/bank-reconciliation');
    expect(r!.items[0]).toMatchObject({ key: 'bank_reconciled', fixHref: BANK_RECONCILED_FIX_HREF });
  });
});
