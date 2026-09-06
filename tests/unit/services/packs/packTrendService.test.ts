import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlMock = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlMock(...a) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { getPackTrend, monthSlots } from '@/modules/accounting/services/packs/packTrendService';

const COMPANY = '11111111-1111-4111-8111-111111111111';

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

  it('scopes the query to the company on both tables', async () => {
    sqlMock.mockResolvedValue([]);
    await getPackTrend(COMPANY, '2026-03-31', 2);
    const params = sqlMock.mock.calls[0]!.slice(1);
    expect(params.filter((p) => p === COMPANY).length).toBeGreaterThanOrEqual(2);
  });

  it('returns one point per month, zero-filling a month with no journals', async () => {
    sqlMock.mockResolvedValue([{ month: '2026-03', revenue: '1000.50', expenses: '400.25' }]);
    const points = await getPackTrend(COMPANY, '2026-03-31', 2);
    expect(points).toEqual([
      { month: '2026-02', label: 'Feb 2026', revenue: 0, expenses: 0, netProfit: 0 },
      { month: '2026-03', label: 'Mar 2026', revenue: 1000.5, expenses: 400.25, netProfit: 600.25 },
    ]);
  });

  it('clamps months to the 1-12 range', async () => {
    sqlMock.mockResolvedValue([]);
    expect(await getPackTrend(COMPANY, '2026-03-31', 99)).toHaveLength(12);
    expect(await getPackTrend(COMPANY, '2026-03-31', 0)).toHaveLength(1);
  });
});
