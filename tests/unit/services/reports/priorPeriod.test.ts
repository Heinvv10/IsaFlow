/**
 * The comparative period, computed on the calendar rather than in milliseconds.
 *
 * The income-statement page did this:
 *
 *   const durationMs = end.getTime() - start.getTime();
 *   const priorEnd   = new Date(start.getTime() - 1);
 *   const priorStart = new Date(priorEnd.getTime() - durationMs);
 *   params.set('compare_start', priorStart.toISOString().split('T')[0]);
 *
 * Two defects in four lines. It is a ROLLING WINDOW, not a prior period: March
 * (31 days) compares against 29 January – 28 February, so a month-on-month
 * comparative is not months and February's own figures never appear. And
 * `toISOString()` renders in UTC on a UTC+2 host, so any window whose boundary
 * falls before 02:00 SAST reports the previous day — the defect class this repo
 * has already been bitten by four times.
 *
 * These functions are pure and take 'YYYY-MM-DD' strings, so there is no Date
 * arithmetic to get wrong and no timezone to render in.
 */
import { describe, it, expect } from 'vitest';
import {
  priorPeriod,
  priorYearPeriod,
} from '@/modules/accounting/services/reports/priorPeriod';

describe('priorPeriod', () => {
  it('gives the whole preceding MONTH for a whole month, not a rolling window', () => {
    // The defect, exactly. 31 days back from 28 February is 29 January.
    expect(priorPeriod('2026-03-01', '2026-03-31')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28',
    });
  });

  it('handles a leap February, and the month lengths either side of it', () => {
    expect(priorPeriod('2024-03-01', '2024-03-31')).toEqual({
      start: '2024-02-01',
      end: '2024-02-29',
    });
    expect(priorPeriod('2024-02-01', '2024-02-29')).toEqual({
      start: '2024-01-01',
      end: '2024-01-31',
    });
  });

  it('crosses a year boundary', () => {
    expect(priorPeriod('2026-01-01', '2026-01-31')).toEqual({
      start: '2025-12-01',
      end: '2025-12-31',
    });
  });

  it('gives the preceding quarter for a quarter', () => {
    expect(priorPeriod('2026-04-01', '2026-06-30')).toEqual({
      start: '2026-01-01',
      end: '2026-03-31',
    });
  });

  it('falls back to the same LENGTH for a window that is not whole months', () => {
    // A 10-day window has no calendar predecessor, so the immediately
    // preceding 10 days is the only defensible answer — and it is labelled as
    // such by the caller rather than presented as "last month".
    expect(priorPeriod('2026-03-10', '2026-03-19')).toEqual({
      start: '2026-02-28',
      end: '2026-03-09',
    });
  });

  it('never renders through a Date: a UTC+2 host reports the same day', () => {
    // The 00:30-SAST case. Nothing here constructs a Date, so there is no
    // rendering step in which the day can shift.
    expect(priorPeriod('2026-07-01', '2026-07-31').end).toBe('2026-06-30');
    expect(priorPeriod('2026-01-01', '2026-12-31')).toEqual({
      start: '2025-01-01',
      end: '2025-12-31',
    });
  });
});

describe('priorYearPeriod', () => {
  it('is the same window one year earlier', () => {
    expect(priorYearPeriod('2026-03-01', '2026-03-31')).toEqual({
      start: '2025-03-01',
      end: '2025-03-31',
    });
  });

  it('clamps 29 February to the 28th in a non-leap year', () => {
    // 2025-02-29 does not exist; Postgres would throw 22008 on the cast, and a
    // Date would roll it forward to 1 March and compare the wrong window.
    expect(priorYearPeriod('2024-02-01', '2024-02-29')).toEqual({
      start: '2023-02-01',
      end: '2023-02-28',
    });
  });
});
