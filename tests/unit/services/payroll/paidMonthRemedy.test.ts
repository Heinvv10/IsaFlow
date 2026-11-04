import { describe, expect, it } from 'vitest';
import { paidNote, paidRemedy } from '@/modules/accounting/services/payroll/payrollComponentPaidMonths';

describe('how a paid month is described and undone', () => {
  it('an approved run is reopened', () => {
    expect(paidNote({ year: 2026, month: 2 })).toBe('(approved run)');
    expect(paidRemedy({ year: 2026, month: 2 })).toBe('Reopen that run and reverse its journal first');
  });

  it('a reopened run whose journal is still posted has its journal reversed', () => {
    expect(paidNote({ year: 2026, month: 2, reopened: true })).toMatch(/journal is still posted/);
    expect(paidRemedy({ year: 2026, month: 2, reopened: true })).toBe('Reverse its journal first');
  });
});
