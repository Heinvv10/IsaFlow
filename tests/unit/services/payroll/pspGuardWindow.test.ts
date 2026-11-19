/** The PSP component guard judges the run's own days (review of #1566, merge L1): a weekly run's dates, else the month. */
import { describe, expect, it } from 'vitest';
import { pspGuardWindow } from '@/modules/accounting/services/payroll/pspComponentGuard';

describe('pspGuardWindow', () => {
  it('a monthly run: the calendar month, to its last day', () => {
    expect(pspGuardWindow({ year: 2026, month: 2 })).toEqual({ start: '2026-02-01', end: '2026-02-28' });
    expect(pspGuardWindow({ year: 2028, month: 2 })).toEqual({ start: '2028-02-01', end: '2028-02-29' });
  });
  it('a weekly or fortnightly run: its own dates, never the month', () => {
    expect(pspGuardWindow({ year: 2026, month: 3, start: '2026-03-09', end: '2026-03-15' })).toEqual({ start: '2026-03-09', end: '2026-03-15' });
  });
});
