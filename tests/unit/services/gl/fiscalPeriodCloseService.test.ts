/**
 * closePeriodWithReadiness (MCP close_fiscal_period) judges nothing itself:
 * the dry run IS `judgePeriodClose` and the live close IS
 * `closePeriodWithVerdict`, the same lock, guards and readiness gate the app's
 * Close runs (fiscalPeriodCloseWrites / periodCloseGate, tested there). So a
 * dry run refuses wherever the live call would (B5: open prior periods
 * included), and the checklist it returns is the verdict judged under the lock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/gl/fiscalPeriodService', () => ({
  judgePeriodClose: vi.fn(),
  closePeriodWithVerdict: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { closePeriodWithVerdict, judgePeriodClose } from '@/modules/accounting/services/gl/fiscalPeriodService';
import {
  closePeriodWithReadiness, PeriodCloseBlockedError, PeriodNotCloseableError,
} from '@/modules/accounting/services/gl/fiscalPeriodCloseService';
import type { FiscalPeriod } from '@/modules/accounting/types/gl.types';
import type { ChecklistItem, CloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';

const COMPANY = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const PERIOD = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const USER = 'user-1';

const period = (status: FiscalPeriod['status']): FiscalPeriod => ({
  id: PERIOD, periodName: 'March 2026', periodNumber: 1, fiscalYear: 2027,
  startDate: '2026-03-01', endDate: '2026-03-31', status, createdAt: 'now', updatedAt: 'now',
});
const item = (key: string, status: ChecklistItem['status']): ChecklistItem =>
  ({ key: key as ChecklistItem['key'], label: key, status, reason: 'r', fixHref: `/x/${key}` });
const verdict = (items: ChecklistItem[]): CloseReadiness =>
  ({ periodId: PERIOD, periodLabel: 'March 2026', items, overallStatus: 'pass' });

beforeEach(() => { vi.resetAllMocks(); });

describe('closePeriodWithReadiness', () => {
  it('live: closes through closePeriodWithVerdict and reports the verdict judged under its lock', async () => {
    vi.mocked(closePeriodWithVerdict).mockResolvedValue({
      period: period('closed'), readiness: verdict([item('tb_balanced', 'pass'), item('vat_reviewed', 'warn')]),
    });
    const r = await closePeriodWithReadiness(COMPANY, PERIOD, USER, {});
    expect(closePeriodWithVerdict).toHaveBeenCalledWith(COMPANY, PERIOD, USER);
    expect(judgePeriodClose).not.toHaveBeenCalled();
    expect(r).toMatchObject({ closed: true, dryRun: false, period: { status: 'closed' } });
    expect(r.checklist.map((i) => i.key)).toEqual(['tb_balanced', 'vat_reviewed']);
    expect(r.warnings.map((i) => i.key)).toEqual(['vat_reviewed']);
  });

  it('dry run: the same judgement (judgePeriodClose), and no write', async () => {
    vi.mocked(judgePeriodClose).mockResolvedValue({ period: period('open'), readiness: verdict([item('tb_balanced', 'pass')]) });
    const r = await closePeriodWithReadiness(COMPANY, PERIOD, USER, { dryRun: true });
    expect(judgePeriodClose).toHaveBeenCalledWith(COMPANY, PERIOD);
    expect(closePeriodWithVerdict).not.toHaveBeenCalled();
    expect(r).toMatchObject({ closed: false, dryRun: true });
  });

  it.each([
    ['a failing check', new PeriodCloseBlockedError('March 2026', [item('bank_reconciled', 'fail')], [], PERIOD)],
    ['open prior periods (B5)', new PeriodNotCloseableError('March 2026 cannot be closed: prior periods are still open (February 2026). Close them first.')],
  ])('%s: the dry run and the live close refuse with the same typed error', async (_n, err) => {
    vi.mocked(judgePeriodClose).mockRejectedValue(err);
    vi.mocked(closePeriodWithVerdict).mockRejectedValue(err);
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, { dryRun: true })).rejects.toBe(err);
    await expect(closePeriodWithReadiness(COMPANY, PERIOD, USER, {})).rejects.toBe(err);
  });
});
