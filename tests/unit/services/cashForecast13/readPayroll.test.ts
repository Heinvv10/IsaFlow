import { describe, it, expect, vi, beforeEach } from 'vitest';
import { formatCents } from '@/lib/money/formatMoney';

const rows = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: Object.assign((..._a: unknown[]) => rows(), { unsafe: (text: string) => ({ unsafe: text }) }) }));

import { payrollItems, readPayroll, toMonthlyRun, type PayrollRead } from '@/modules/accounting/services/cashForecast13/readPayroll';
import type { ForecastWarning } from '@/modules/accounting/services/cashForecast13/types';

const row = (over: Record<string, unknown>) => ({
  id: 'r1', period_year: 2026, period_month: 10, status: 'approved', pay_frequency: 'monthly',
  total_net: '9000.00', total_paye: '1500.00', total_eti: '0.00', total_uif: '200.00', total_sdl: '100.00', ...over,
});
const TODAY = '2026-11-18';
const END = '2027-02-14';

beforeEach(() => rows.mockReset());

describe('cash13 payroll', () => {
  it('statutory = max(0, PAYE − ETI) + UIF + SDL', () => {
    expect(toMonthlyRun(row({})).statutoryCents).toBe(180_000);
    expect(toMonthlyRun(row({ total_eti: '400.00' })).statutoryCents).toBe(140_000);
    expect(toMonthlyRun(row({ total_eti: '2000.00' })).statutoryCents).toBe(30_000);
  });

  it('only monthly regular runs count; a weekly or fortnightly one is flagged, never used', async () => {
    rows.mockResolvedValue([row({ id: 'w', period_month: 11, pay_frequency: 'weekly', total_net: '1.00' }), row({})]);
    const read = await readPayroll('co');
    expect(read.latest?.id).toBe('r1');
    expect(read.unsupportedFrequency).toBe(true);
  });

  it('pays each pay date from today at the month’s own run, else the latest run; past pay dates are assumed paid and the recent ones listed', () => {
    const read: PayrollRead = {
      latest: toMonthlyRun(row({ id: 'nov', period_month: 11, total_net: '9500.00' })),
      runs: [toMonthlyRun(row({ id: 'nov', period_month: 11, total_net: '9500.00' })), toMonthlyRun(row({}))],
      unsupportedFrequency: false,
    };
    const warnings: ForecastWarning[] = [];
    const items = payrollItems(read, 25, TODAY, END, warnings);
    expect(items.map((i) => [i.date, i.amountCents, i.ref])).toEqual([
      ['2026-11-25', -950_000, 'nov:2026-11-25'],
      ['2026-12-24', -950_000, 'nov:2026-12-24'],
      ['2027-01-25', -950_000, 'nov:2027-01-25'],
    ]);
    // October's run paid on 2026-10-23 (25th is a Sunday) is not forecast, and is listed.
    expect(warnings).toEqual([expect.objectContaining({ code: 'payroll_past_assumed_paid' })]);
    expect(warnings[0]!.message).toContain(`2026-10 on 2026-10-23 ${formatCents(900_000)}`);
  });

  it('a month with its own run pays that run, not the latest one', () => {
    const nov = toMonthlyRun(row({ id: 'nov', period_month: 11, total_net: '9500.00' }));
    const dec = toMonthlyRun(row({ id: 'dec', period_month: 12, total_net: '9800.00' }));
    const items = payrollItems({ latest: dec, runs: [dec, nov], unsupportedFrequency: false }, 25, TODAY, END, []);
    expect(items.map((i) => [i.date, i.amountCents])).toEqual([['2026-11-25', -950_000], ['2026-12-24', -980_000], ['2027-01-25', -980_000]]);
  });

  it('a pay date already passed this month is not forecast again; a paid month is skipped', () => {
    const oct = toMonthlyRun(row({}));
    const read: PayrollRead = { latest: oct, runs: [oct], unsupportedFrequency: false };
    expect(payrollItems(read, 15, TODAY, END, []).map((i) => i.date)).toEqual(['2026-12-15', '2027-01-15', '2027-02-15'].filter((d) => d <= END));
    const nov = { ...toMonthlyRun(row({ id: 'n', period_month: 11 })), status: 'paid' };
    expect(payrollItems({ latest: nov, runs: [nov, oct], unsupportedFrequency: false }, 25, TODAY, END, [])[0]!.date).toBe('2026-12-24');
  });

  it('a net pay of zero or less gives no line; no run gives no line', () => {
    const zero = toMonthlyRun(row({ total_net: '0.00' }));
    expect(payrollItems({ latest: zero, runs: [zero], unsupportedFrequency: false }, 25, TODAY, END, [])).toEqual([]);
    expect(payrollItems({ latest: null, runs: [], unsupportedFrequency: false }, 25, TODAY, END, [])).toEqual([]);
  });
});
