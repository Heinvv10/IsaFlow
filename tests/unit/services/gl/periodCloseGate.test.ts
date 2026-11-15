/**
 * The one server-side period-close gate (Hein, 2026-11-15): every path that
 * closes a period — the app's Close, Bulk Close, Close Year, MCP
 * close_fiscal_period — refuses when a readiness check FAILS, or could not be
 * computed. An ordinary warning (no VAT return, opening-balance equity not
 * cleared) never blocks. The refusal names each failing check with its reason
 * and the screen that fixes it, per period.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/modules/accounting/services/gl/periodCloseReadinessService', () => ({
  getCloseReadiness: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getCloseReadiness, type ChecklistItem, type CloseReadiness } from '@/modules/accounting/services/gl/periodCloseReadinessService';
import { assertPeriodCloseReady, assertYearCloseReady } from '@/modules/accounting/services/gl/periodCloseGate';
import {
  PERIOD_CLOSE_NOT_READY, PeriodCloseBlockedError, YearCloseBlockedError, closeRefusalDetails, isCloseBlocker,
} from '@/modules/accounting/services/gl/periodCloseErrors';

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function item(key: string, status: ChecklistItem['status'], reason = `${key} reason`): ChecklistItem {
  return { key: key as ChecklistItem['key'], label: `${key} label`, status, reason, fixHref: `/fix/${key}` };
}

function readiness(periodId: string, periodLabel: string, items: ChecklistItem[]): CloseReadiness {
  return { periodId, periodLabel, items, overallStatus: 'pass' };
}

beforeEach(() => { vi.clearAllMocks(); });

describe('isCloseBlocker', () => {
  it('blocks on fail, and on a warn that says the check could not be computed', () => {
    expect(isCloseBlocker(item('bank_reconciled', 'fail'))).toBe(true);
    expect(isCloseBlocker(item('ap_ties', 'warn', 'Could not compute — the AP reconciliation failed to run.'))).toBe(true);
  });
  it('does not block on pass or on an ordinary warning', () => {
    expect(isCloseBlocker(item('tb_balanced', 'pass'))).toBe(false);
    expect(isCloseBlocker(item('vat_reviewed', 'warn', 'No VAT return covers this period.'))).toBe(false);
  });
});

describe('assertPeriodCloseReady', () => {
  it('returns the readiness when every check passes or only warns', async () => {
    const r = readiness('p1', 'January 2026', [item('tb_balanced', 'pass'), item('vat_reviewed', 'warn')]);
    vi.mocked(getCloseReadiness).mockResolvedValue(r);
    await expect(assertPeriodCloseReady(COMPANY, 'p1')).resolves.toBe(r);
    expect(getCloseReadiness).toHaveBeenCalledWith(COMPANY, 'p1');
  });

  it('refuses with every failing check, and none of the passes or warnings', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue(readiness('p1', 'January 2026', [
      item('bank_reconciled', 'fail', '1 unreconciled bank transaction remains in this period.'),
      item('vat_reviewed', 'warn'),
      item('unposted_journals', 'fail'),
      item('tb_balanced', 'pass'),
    ]));
    const err = await assertPeriodCloseReady(COMPANY, 'p1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PeriodCloseBlockedError);
    const blocked = err as PeriodCloseBlockedError;
    expect(blocked.blockers.map((b) => b.key)).toEqual(['bank_reconciled', 'unposted_journals']);
    expect(blocked.message).toMatch(/^January 2026 cannot be closed — 2 checks did not pass/);
    expect(closeRefusalDetails(blocked)).toEqual({
      code: PERIOD_CLOSE_NOT_READY,
      periods: [{
        periodId: 'p1', periodName: 'January 2026',
        blockers: [
          { key: 'bank_reconciled', label: 'bank_reconciled label',
            reason: '1 unreconciled bank transaction remains in this period.', fixHref: '/fix/bank_reconciled' },
          { key: 'unposted_journals', label: 'unposted_journals label',
            reason: 'unposted_journals reason', fixHref: '/fix/unposted_journals' },
        ],
      }],
    });
  });

  it('refuses a check that could not be computed', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue(readiness('p1', 'January 2026', [
      item('ar_ties', 'warn', 'Could not compute — check the relevant module.'),
    ]));
    await expect(assertPeriodCloseReady(COMPANY, 'p1')).rejects.toBeInstanceOf(PeriodCloseBlockedError);
  });

  it('throws (not a pass) when the period cannot be read', async () => {
    vi.mocked(getCloseReadiness).mockResolvedValue(null);
    await expect(assertPeriodCloseReady(COMPANY, 'gone')).rejects.toThrow(/not found/);
  });
});

describe('assertYearCloseReady', () => {
  it('evaluates EVERY period and names each failing one, not just the first', async () => {
    vi.mocked(getCloseReadiness).mockImplementation(async (_c, id) => ({
      p1: readiness('p1', 'Jan', [item('bank_reconciled', 'fail')]),
      p2: readiness('p2', 'Feb', [item('vat_reviewed', 'warn')]),
      p3: readiness('p3', 'Mar', [item('tb_balanced', 'fail'), item('unposted_journals', 'fail')]),
    } as Record<string, CloseReadiness>)[id] ?? null);

    const err = await assertYearCloseReady(COMPANY, 2026, [
      { id: 'p1', periodName: 'Jan' }, { id: 'p2', periodName: 'Feb' }, { id: 'p3', periodName: 'Mar' },
    ]).catch((e: unknown) => e);

    expect(getCloseReadiness).toHaveBeenCalledTimes(3);
    expect(err).toBeInstanceOf(YearCloseBlockedError);
    const year = err as YearCloseBlockedError;
    expect(year.fiscalYear).toBe(2026);
    expect(year.periods.map((p) => [p.periodId, p.blockers.map((b) => b.key)])).toEqual([
      ['p1', ['bank_reconciled']], ['p3', ['tb_balanced', 'unposted_journals']],
    ]);
    expect(year.message).toMatch(/Fiscal year 2026 cannot be closed — 2 periods did not pass/);
    expect(closeRefusalDetails(year)).toMatchObject({ code: PERIOD_CLOSE_NOT_READY, fiscalYear: 2026 });
  });

  it('passes when no period has a blocker', async () => {
    vi.mocked(getCloseReadiness).mockImplementation(async (_c, id) => readiness(id, id, [item('vat_reviewed', 'warn')]));
    await expect(assertYearCloseReady(COMPANY, 2026, [{ id: 'p1', periodName: 'Jan' }, { id: 'p2', periodName: 'Feb' }]))
      .resolves.toBeUndefined();
  });

  it('rethrows anything that is not a refusal', async () => {
    vi.mocked(getCloseReadiness).mockRejectedValue(new Error('connection lost'));
    await expect(assertYearCloseReady(COMPANY, 2026, [{ id: 'p1', periodName: 'Jan' }])).rejects.toThrow('connection lost');
  });
});
