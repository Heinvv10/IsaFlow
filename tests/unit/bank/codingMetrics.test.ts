/**
 * Learning-loop coding metrics — the pure computation (codingMetrics.ts). The SQL that produces the counts
 * (undone runs, hand-corrected lines, the first-import window against a real schema) is pinned by
 * tests/integration/coding-metrics-counts.int.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  aggregateCodingMetrics, computeCodingMetrics, currentSaMonth, firstWindow, monthPeriod, ratio,
  FIRST_WINDOW_DAYS, MIN_DECISIONS_FOR_RATE, type CompanyCodingCounts,
} from '@/modules/accounting/services/bank/codingMetrics';

function counts(over: Partial<CompanyCodingCounts> = {}): CompanyCodingCounts {
  return {
    companyId: 'c1', linesCoded: 0, linesAutoCoded: 0, suggestionsDecided: 0, suggestionsAccepted: 0,
    autoPosted: 0, autoPostedReversed: 0, firstBatchAt: null, firstLineAt: null,
    firstWindowDecided: 0, firstWindowAccepted: 0, decisionLogSince: null, ...over,
  };
}

describe('ratio', () => {
  it('zero denominator: no percentage, not enough data', () => {
    expect(ratio(0, 0)).toEqual({ numerator: 0, denominator: 0, pct: null, enoughData: false });
  });
  it('rounds to one decimal', () => {
    expect(ratio(1, 3).pct).toBe(33.3);
    expect(ratio(2, 3).pct).toBe(66.7);
  });
  it('below the minimum: counts kept, no percentage', () => {
    const r = ratio(5, MIN_DECISIONS_FOR_RATE - 1, MIN_DECISIONS_FOR_RATE);
    expect(r).toMatchObject({ numerator: 5, denominator: MIN_DECISIONS_FOR_RATE - 1, pct: null, enoughData: false });
  });
  it('at the minimum: a percentage', () => {
    expect(ratio(10, MIN_DECISIONS_FOR_RATE, MIN_DECISIONS_FOR_RATE)).toMatchObject({ pct: 50, enoughData: true });
  });
});

describe('computeCodingMetrics', () => {
  it('a company with no lines and no decisions has no rates at all', () => {
    const m = computeCodingMetrics(counts());
    expect(m.autoCoded.pct).toBeNull();
    expect(m.suggestionsAccepted.pct).toBeNull();
    expect(m.firstThirtyDays).toMatchObject({ pct: null, windowStart: null, windowEnd: null, windowSource: null });
    expect(m.autoPostRecodeRate.pct).toBeNull();
  });

  it('the headline needs no minimum (it is backfilled): 3 of 4 coded lines with no click is 75%', () => {
    expect(computeCodingMetrics(counts({ linesCoded: 4, linesAutoCoded: 3 })).autoCoded).toMatchObject({ pct: 75, enoughData: true });
  });

  it('decision-log rates wait for the minimum', () => {
    const m = computeCodingMetrics(counts({ suggestionsDecided: 19, suggestionsAccepted: 19, autoPosted: 19, autoPostedReversed: 1 }));
    expect(m.suggestionsAccepted.enoughData).toBe(false);
    expect(m.autoPostRecodeRate.enoughData).toBe(false);
  });

  it('re-code rate on auto-posted lines is reversed / auto-posted', () => {
    expect(computeCodingMetrics(counts({ autoPosted: 40, autoPostedReversed: 6 })).autoPostRecodeRate.pct).toBe(15);
  });

  it('the first-30-days window starts at the first import batch', () => {
    const m = computeCodingMetrics(counts({
      firstBatchAt: '2026-10-01T08:00:00.000Z', firstLineAt: null, firstWindowDecided: 20, firstWindowAccepted: 15,
    }));
    expect(m.firstThirtyDays).toMatchObject({
      pct: 75, windowStart: '2026-10-01T08:00:00.000Z', windowEnd: '2026-10-31T08:00:00.000Z', windowSource: 'import_batch',
    });
  });

  it('with no batch rows, the window falls back to the first bank line', () => {
    const m = computeCodingMetrics(counts({ firstLineAt: '2026-09-15T00:00:00.000Z' }));
    expect(m.firstThirtyDays.windowSource).toBe('bank_transaction');
    expect(m.firstThirtyDays.windowStart).toBe('2026-09-15T00:00:00.000Z');
  });
});

describe('firstWindow', () => {
  it('a batch wins over a line', () => {
    expect(firstWindow('2026-01-10T00:00:00Z', '2026-01-01T00:00:00Z')).toEqual({
      start: '2026-01-10T00:00:00.000Z', end: '2026-02-09T00:00:00.000Z', source: 'import_batch',
    });
  });
  it('is FIRST_WINDOW_DAYS long', () => {
    const w = firstWindow(null, '2026-03-01T00:00:00Z');
    expect((new Date(w.end!).getTime() - new Date(w.start!).getTime()) / 86_400_000).toBe(FIRST_WINDOW_DAYS);
  });
  it('nothing imported: no window', () => {
    expect(firstWindow(null, null)).toEqual({ start: null, end: null, source: null });
  });
});

describe('aggregateCodingMetrics (bureau total)', () => {
  it('pools the counts, so a big client weighs more than a small one', () => {
    const big = counts({ companyId: 'big', linesCoded: 900, linesAutoCoded: 900 });
    const small = counts({ companyId: 'small', linesCoded: 100, linesAutoCoded: 0 });
    // Pooled: 900 / 1000 = 90%. An average of the two clients' rates would say 50%.
    expect(aggregateCodingMetrics([big, small]).autoCoded.pct).toBe(90);
  });
  it('sums decisions before applying the minimum', () => {
    const a = counts({ companyId: 'a', suggestionsDecided: 10, suggestionsAccepted: 8 });
    const b = counts({ companyId: 'b', suggestionsDecided: 10, suggestionsAccepted: 4 });
    expect(aggregateCodingMetrics([a, b]).suggestionsAccepted).toMatchObject({ numerator: 12, denominator: 20, pct: 60 });
  });
  it('the earliest decision-log date across clients', () => {
    const a = counts({ companyId: 'a', decisionLogSince: '2026-10-22T00:00:00.000Z' });
    const b = counts({ companyId: 'b', decisionLogSince: '2026-10-21T00:00:00.000Z' });
    expect(aggregateCodingMetrics([a, b, counts({ companyId: 'c' })]).decisionLogSince).toBe('2026-10-21T00:00:00.000Z');
  });
  it('no clients: nothing', () => {
    expect(aggregateCodingMetrics([]).autoCoded.pct).toBeNull();
  });
});

describe('monthPeriod / currentSaMonth', () => {
  it('a month is [first day, first day of next month)', () => {
    expect(monthPeriod('2026-10')).toEqual({ month: '2026-10', from: '2026-10-01', to: '2026-11-01' });
    expect(monthPeriod('2026-12')).toEqual({ month: '2026-12', from: '2026-12-01', to: '2027-01-01' });
  });
  it('refuses anything else', () => {
    for (const bad of ['2026-13', '2026-1', '26-10', '2026-10-01', "2026-10'; DROP", '']) expect(monthPeriod(bad)).toBeNull();
  });
  it('is the South African month (UTC+2) at the UTC month boundary', () => {
    expect(currentSaMonth(new Date('2026-10-31T22:30:00Z'))).toBe('2026-11');
    expect(currentSaMonth(new Date('2026-10-31T21:59:00Z'))).toBe('2026-10');
  });
});
