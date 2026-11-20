/** Wave 6 FQd (review #1622 UI L4): a run with no lines says the right next step. */
import { describe, expect, it } from 'vitest';
import { emptyLinesMessage } from '@/components/payroll/runEmptyLines';

describe('emptyLinesMessage', () => {
  it('never calculated: press Calculate (or nothing to do for a reader)', () => {
    expect(emptyLinesMessage({ status: 'draft', payFrequency: 'fortnightly' }, true)).toBe('No lines yet. Press Calculate to generate payroll for this period.');
    expect(emptyLinesMessage({ status: 'draft' }, false)).toBe('No lines yet.');
  });
  it('calculated and empty: nobody is paid at the frequency, and where to set it', () => {
    expect(emptyLinesMessage({ status: 'calculated', payFrequency: 'fortnightly' }, true))
      .toBe("No employee is paid fortnightly, so nobody is on this run. Set the pay frequency on the employee's profile, then recalculate.");
  });
});
