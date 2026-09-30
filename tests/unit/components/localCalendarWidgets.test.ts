import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildLast12Months } from '@/components/dashboard/widgets/SalesHistoryWidget';
import { resolveAsof, resolveRange } from '@/components/practice/PeriodPicker';

const ORIGINAL_TZ = process.env.TZ;
beforeAll(() => { process.env.TZ = 'Africa/Johannesburg'; });
afterEach(() => { vi.useRealTimers(); });
afterAll(() => {
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
});

describe('SalesHistoryWidget.buildLast12Months (SAST)', () => {
  it('ends on the current month and starts 11 months earlier', () => {
    const months = buildLast12Months(new Date(2026, 8, 30));
    expect(months).toHaveLength(12);
    expect(months[0]).toBe('2025-10');
    expect(months[11]).toBe('2026-09');
  });
  it('crosses a year boundary', () => {
    const months = buildLast12Months(new Date(2026, 0, 15));
    expect(months[0]).toBe('2025-02');
    expect(months[11]).toBe('2026-01');
  });
});

describe('PeriodPicker presets (SAST, 00:30 on 30 Sep 2026)', () => {
  const at = () => vi.useFakeTimers({ toFake: ['Date'] }) && vi.setSystemTime(new Date(2026, 8, 30, 0, 30));
  it('range presets', () => {
    at();
    expect(resolveRange('this_month')).toEqual({ dateFrom: '2026-09-01', dateTo: '2026-09-30' });
    expect(resolveRange('last_month')).toEqual({ dateFrom: '2026-08-01', dateTo: '2026-08-31' });
    expect(resolveRange('this_quarter')).toEqual({ dateFrom: '2026-07-01', dateTo: '2026-09-30' });
    expect(resolveRange('ytd')).toEqual({ dateFrom: '2026-01-01', dateTo: '2026-09-30' });
    expect(resolveRange('last_year')).toEqual({ dateFrom: '2025-01-01', dateTo: '2025-12-31' });
  });
  it('as-of presets', () => {
    at();
    expect(resolveAsof('today')).toBe('2026-09-30');
    expect(resolveAsof('month_end')).toBe('2026-09-30');
    expect(resolveAsof('quarter_end')).toBe('2026-09-30');
  });
  it('1 Sep 00:30 is still September (UTC would say 31 Aug)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 8, 1, 0, 30));
    expect(resolveRange('this_month')?.dateFrom).toBe('2026-09-01');
    expect(resolveRange('last_month')).toEqual({ dateFrom: '2026-08-01', dateTo: '2026-08-31' });
  });
});
