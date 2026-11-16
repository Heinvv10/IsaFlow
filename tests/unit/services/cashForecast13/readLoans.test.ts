import { describe, it, expect, vi, beforeEach } from 'vitest';

const queries: Array<() => unknown> = [];
const schedule = vi.fn();
vi.mock('@/lib/neon', () => ({
  sql: (strings: TemplateStringsArray) => Promise.resolve((queries.shift() ?? (() => []))() as unknown).then((r) => { void strings; return r; }),
  withSavepoint: (_n: string, fn: () => Promise<unknown>) => fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/modules/accounting/services/loans/loanScheduleService', () => ({ previewSchedule: (...a: unknown[]) => schedule(...a) }));

import { loanItems } from '@/modules/accounting/services/cashForecast13/readLoans';
import type { ForecastWarning } from '@/modules/accounting/services/cashForecast13/types';

const TODAY = '2026-11-18';
const END = '2027-02-14';
const loan = (id: string, over: Record<string, unknown> = {}) => ({ id, label: `L-${id}`, principal: '1000', currency: 'ZAR', functional_currency: 'ZAR', ...over });
const rows = ['2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01'].map((date, i) => ({ period: i + 1, date, payment: 100, lump: 0 }));

beforeEach(() => { queries.length = 0; schedule.mockReset(); });

describe('cash13 loan reader (review L2, L1, L6)', () => {
  it('no recorded payment: past instalments assumed paid, future forecast, loan_payments_not_recorded', async () => {
    queries.push(() => [loan('a')], () => []);
    schedule.mockResolvedValue(rows);
    const w: ForecastWarning[] = [];
    const items = await loanItems('co', TODAY, END, w);
    expect(items.map((i) => [i.ref, i.amountCents, i.flags])).toEqual([['a:4', -10_000, undefined]]);
    expect(w.map((x) => x.code)).toEqual(['loan_payments_not_recorded']);
  });

  it('with payments: a missed instalment after the first payment is week-1 loan_overdue; matched ones are not forecast', async () => {
    queries.push(() => [loan('b')], () => [{ period_number: 1, payment_date: '2026-09-01', amount: '100.00' }, { period_number: null, payment_date: '2026-11-03', amount: '100.00' }]);
    schedule.mockResolvedValue(rows);
    const w: ForecastWarning[] = [];
    const items = await loanItems('co', TODAY, END, w);
    expect(items.map((i) => [i.ref, i.date, i.flags])).toEqual([['b:2', '2026-10-01', ['loan_overdue']], ['b:4', '2026-12-01', undefined]]);
    expect(w).toEqual([]);
  });

  it('a foreign-currency loan is left out with currency_not_converted; a refused schedule is that loan’s warning; the other loan goes on', async () => {
    queries.push(() => [loan('usd', { currency: 'USD' }), loan('bad'), loan('ok')], () => []);
    schedule.mockImplementation((_co: string, id: string) => (id === 'bad' ? Promise.reject(new Error('Rate curve is empty')) : Promise.resolve(rows)));
    const w: ForecastWarning[] = [];
    const items = await loanItems('co', TODAY, END, w);
    expect(items.map((i) => i.ref)).toEqual(['ok:4']);
    expect(w.map((x) => x.code).sort()).toEqual(['currency_not_converted', 'loan_payments_not_recorded', 'source_unavailable']);
    expect(schedule).not.toHaveBeenCalledWith('co', 'usd');
  });

  it('a code bug in a schedule propagates', async () => {
    queries.push(() => [loan('x')]);
    schedule.mockRejectedValue(new TypeError('bug'));
    await expect(loanItems('co', TODAY, END, [])).rejects.toThrow('bug');
  });
});
