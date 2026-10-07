/**
 * `reportWindowProblem` — the one window check the ratio routes share. Their
 * day ratios multiply by the window's length, so a date that is not on the
 * calendar or a window that runs backwards is refused before any read.
 */
import { describe, expect, it } from 'vitest';
import { reportWindowProblem } from '@/lib/validation';

describe('reportWindowProblem', () => {
  it('accepts a real window, including a single day', () => {
    expect(reportWindowProblem('2026-03-01', '2026-08-31')).toBeNull();
    expect(reportWindowProblem('2026-08-31', '2026-08-31')).toBeNull();
    expect(reportWindowProblem('2024-02-29', '2024-03-01')).toBeNull();
  });

  it('refuses a date that is not on the calendar, though it has the shape', () => {
    // DATE_RE passes it and Date.UTC rolls it to 3 March.
    expect(reportWindowProblem('2026-02-31', '2026-08-31')).toBe('from and to must be YYYY-MM-DD dates');
    expect(reportWindowProblem('2026-03-01', '2026-13-01')).toBe('from and to must be YYYY-MM-DD dates');
    expect(reportWindowProblem('2025-02-29', '2025-03-31')).toBe('from and to must be YYYY-MM-DD dates');
  });

  it('refuses a malformed date at either end', () => {
    expect(reportWindowProblem('2026-03-1x', '2026-08-31')).toBe('from and to must be YYYY-MM-DD dates');
    expect(reportWindowProblem('2026-03-01', 'yesterday')).toBe('from and to must be YYYY-MM-DD dates');
  });

  it('refuses a year before 1900, which Date.UTC would read as 19xx', () => {
    expect(reportWindowProblem('0099-01-01', '2026-08-31')).toBe('from and to must be dates from 1900 on');
    expect(reportWindowProblem('0001-01-01', '0001-12-31')).toBe('from and to must be dates from 1900 on');
    expect(reportWindowProblem('1900-01-01', '1900-12-31')).toBeNull();
  });

  it('refuses a window that runs backwards', () => {
    expect(reportWindowProblem('2026-09-01', '2026-08-31')).toBe('from must not be after to');
  });
});
