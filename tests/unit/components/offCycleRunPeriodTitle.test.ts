/**
 * Review #1679 codex N9: the run page's title names an off-cycle run's scheduled date as its pay date, never "paid": a
 * draft or cancelled run has paid nothing.
 */
import { describe, expect, it } from 'vitest';
import { runPeriodTitle } from '@/components/payroll/RunCards';

const run = (over: Record<string, unknown>) => ({
  id: 'r', periodMonth: 11, periodYear: 2026, status: 'cancelled', totalGross: 0, totalPaye: 0, totalNet: 0, employeeCount: 1,
  journalEntryId: null, runKind: 'off_cycle', offCycleReason: 'bonus', runDate: '2026-11-25', ...over,
});

describe('runPeriodTitle', () => {
  it('labels an off-cycle run\'s date "pay date", whatever its status', () => {
    for (const status of ['draft', 'cancelled', 'approved']) {
      const t = runPeriodTitle(run({ status }));
      expect(t).toMatch(/pay date 25/i);
      expect(t).not.toMatch(/paid/i);
    }
  });
  it('a regular run carries no date', () => {
    expect(runPeriodTitle(run({ runKind: 'regular', offCycleReason: null }))).toBe('Nov 2026');
  });
});
