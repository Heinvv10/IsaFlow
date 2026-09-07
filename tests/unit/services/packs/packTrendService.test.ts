import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getPackTrend, monthSlots } from '@/modules/accounting/services/packs/packTrendService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const OTHER_COMPANY = '22222222-2222-4222-8222-222222222222';

describe('monthSlots', () => {
  it('ends on the month of `to` and counts backwards', () => {
    const slots = monthSlots('2026-03-15', 3);
    expect(slots.map((s) => s.month)).toEqual(['2026-01', '2026-02', '2026-03']);
  });

  it('crosses a year boundary', () => {
    const slots = monthSlots('2026-02-28', 3);
    expect(slots.map((s) => s.month)).toEqual(['2025-12', '2026-01', '2026-02']);
  });

  it('gives each month its real last day, February included', () => {
    const [feb] = monthSlots('2026-02-10', 1);
    expect(feb!.from).toBe('2026-02-01');
    expect(feb!.to).toBe('2026-02-28');
  });

  it('never builds a date through toISOString, which shifts a SAST midnight back a day', () => {
    const slots = monthSlots('2026-01-01', 1);
    expect(slots[0]!.month).toBe('2026-01');
  });
});

describe('getPackTrend', () => {
  beforeEach(() => sqlMock.mockReset());

  it('issues exactly one query', async () => {
    sqlMock.mockResolvedValue([]);
    await getPackTrend(COMPANY, '2026-03-31', 2);
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it('scopes the query to the company on all three tables — a wrong id is a different query', async () => {
    sqlMock.mockResolvedValue([]);
    await getPackTrend(COMPANY, '2026-03-31', 2);
    const params = sqlMock.mock.calls[0]!.slice(1);
    // je.company_id, jl.company_id, ga.company_id — three scoping predicates,
    // not fewer, regardless of how many columns the SELECT list carries.
    expect(params.filter((p) => p === COMPANY)).toHaveLength(3);
    expect(params.filter((p) => p === OTHER_COMPANY)).toHaveLength(0);
  });

  it('returns one point per month, zero-filling a month with no journals', async () => {
    sqlMock.mockResolvedValue([{ month: '2026-03', revenue: '1000.50', expenses: '400.25' }]);
    const points = await getPackTrend(COMPANY, '2026-03-31', 2);
    expect(points).toEqual([
      {
        month: '2026-02', label: 'Feb 2026',
        revenue: 0, expenses: 0, netProfit: 0, costOfSales: 0, operatingExpenses: 0,
        grossMarginPct: null, cash: 0, accountsReceivable: 0, debtorDays: null,
      },
      {
        month: '2026-03', label: 'Mar 2026',
        revenue: 1000.5, expenses: 400.25, netProfit: 600.25, costOfSales: 0, operatingExpenses: 400.25,
        grossMarginPct: 100, cash: 0, accountsReceivable: 0, debtorDays: 0,
      },
    ]);
  });

  it('stops the series at the REPORTING DATE, not at the end of the month containing it', async () => {
    // `cash` and `accountsReceivable` are cumulative positions, so the last
    // bucket carried every posting up to that month's last day: a pack run to
    // 7 September read cash as at 30 September. Sheet 8 of the rendered board
    // pack then stated closing cash as `(532)` in its table and `(752)` in
    // the closing-cash line's title, on the same page, both at R'000, with
    // nothing to say the two were measured over different windows.
    sqlMock.mockResolvedValue([]);
    await getPackTrend(COMPANY, '2026-09-07', 12);
    const params = sqlMock.mock.calls[0]!.slice(1);
    expect(params).toContain('2026-09-07');
    expect(params).not.toContain('2026-09-30');

    // And a `to` that IS a month end is left exactly as it was.
    sqlMock.mockReset();
    sqlMock.mockResolvedValue([]);
    await getPackTrend(COMPANY, '2026-09-30', 12);
    expect(sqlMock.mock.calls[0]!.slice(1)).toContain('2026-09-30');
  });

  it('clamps months to the 1-12 range', async () => {
    sqlMock.mockResolvedValue([]);
    expect(await getPackTrend(COMPANY, '2026-03-31', 99)).toHaveLength(12);
    expect(await getPackTrend(COMPANY, '2026-03-31', 0)).toHaveLength(1);
  });

  it('keeps the three original series unchanged in value and shape', async () => {
    sqlMock.mockResolvedValue([
      { month: '2026-01', revenue: '500.00', expenses: '300.00' },
      { month: '2026-02', revenue: '700.25', expenses: '410.75' },
    ]);
    const points = await getPackTrend(COMPANY, '2026-02-28', 2);
    expect(points.map((p) => ({ month: p.month, label: p.label, revenue: p.revenue, expenses: p.expenses, netProfit: p.netProfit }))).toEqual([
      { month: '2026-01', label: 'Jan 2026', revenue: 500, expenses: 300, netProfit: 200 },
      { month: '2026-02', label: 'Feb 2026', revenue: 700.25, expenses: 410.75, netProfit: 289.5 },
    ]);
  });

  it('carries the cash and receivable BALANCE forward through a month with no movement — never a reset to zero', async () => {
    sqlMock.mockResolvedValue([
      { month: '2026-01', revenue: '0', expenses: '0', cash_movement: '1000', receivable_movement: '500' },
      // 2026-02 has no row at all: no journals posted that month.
      { month: '2026-03', revenue: '0', expenses: '0', cash_movement: '0', receivable_movement: '0' },
    ]);
    const points = await getPackTrend(COMPANY, '2026-03-31', 3);
    expect(points.map((p) => ({ month: p.month, cash: p.cash, accountsReceivable: p.accountsReceivable }))).toEqual([
      { month: '2026-01', cash: 1000, accountsReceivable: 500 },
      { month: '2026-02', cash: 1000, accountsReceivable: 500 }, // carried forward, not reset
      { month: '2026-03', cash: 1000, accountsReceivable: 500 },
    ]);
  });

  it('seeds the running cash and receivable balance from postings before the trend window', async () => {
    sqlMock.mockResolvedValue([
      { month: '__opening__', cash_movement: '5000', receivable_movement: '2000' },
      { month: '2026-03', revenue: '0', expenses: '0', cash_movement: '100', receivable_movement: '0' },
    ]);
    const points = await getPackTrend(COMPANY, '2026-03-31', 1);
    expect(points[0]!.cash).toBe(5100);
    expect(points[0]!.accountsReceivable).toBe(2000);
  });

  it('reports debtor days as not meaningful — never zero — on a month with no revenue, even with a receivable balance', async () => {
    sqlMock.mockResolvedValue([
      { month: '2026-03', revenue: '0', expenses: '0', receivable_movement: '900' },
    ]);
    const points = await getPackTrend(COMPANY, '2026-03-31', 1);
    expect(points[0]!.accountsReceivable).toBe(900);
    expect(points[0]!.debtorDays).toBeNull();
    expect(points[0]!.grossMarginPct).toBeNull();
  });

  it('computes operating expenses as total expenses less cost of sales and below-the-line expense', async () => {
    sqlMock.mockResolvedValue([
      { month: '2026-03', revenue: '1000', expenses: '600', cost_of_sales: '400', below_operating_line: '50' },
    ]);
    const points = await getPackTrend(COMPANY, '2026-03-31', 1);
    expect(points[0]!.costOfSales).toBe(400);
    expect(points[0]!.operatingExpenses).toBe(150); // 600 - 400 - 50
    expect(points[0]!.grossMarginPct).toBe(60); // (1000-400)/1000 * 100
  });
});
