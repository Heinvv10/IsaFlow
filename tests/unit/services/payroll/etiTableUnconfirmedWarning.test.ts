/**
 * Non-blocking warning for ETI claimed on the unconfirmed post-31-March-2026 table.
 * Severity is 'warning', never 'error': it must not stop a run.
 */
import { describe, it, expect } from 'vitest';
import { validateEti } from '@/modules/accounting/services/payroll/validationEngine';

const employee = { id: 'emp-1', firstName: 'Thandi', lastName: 'Mokoena' };
const determined = { isDeterminable: true, missingInputs: [] as never[] };

describe('validateEti - ETI_TABLE_UNCONFIRMED', () => {
  it('warns for ETI > 0 on a period from 1 April 2026', () => {
    const out = validateEti(employee, { ...determined, monthlyEti: 1_500 }, new Date(2026, 3, 28));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ code: 'ETI_TABLE_UNCONFIRMED', severity: 'warning' });
    expect(out[0]!.message).toContain('Thandi Mokoena');
    expect(out[0]!.message).toContain('unconfirmed');
  });

  it('is silent for ETI of zero, even after April 2026', () => {
    expect(validateEti(employee, { ...determined, monthlyEti: 0 }, new Date(2026, 5, 28))).toEqual([]);
  });

  it('is silent up to and including March 2026', () => {
    expect(validateEti(employee, { ...determined, monthlyEti: 1_500 }, new Date(2026, 2, 28))).toEqual([]);
  });

  it('still reports an indeterminate result as before', () => {
    const out = validateEti(
      employee,
      { isDeterminable: false, missingInputs: ['date_of_birth'], monthlyEti: 0 },
      new Date(2026, 5, 28),
    );
    expect(out.map((w) => w.code)).toEqual(['ETI_INDETERMINATE']);
  });
});
