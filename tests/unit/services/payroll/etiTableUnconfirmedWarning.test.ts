/**
 * validateEti no longer warns ETI_TABLE_UNCONFIRMED (ET, wave 5): the April 2025 table is the law with no end date
 * (Rates and Monetary Amounts and Amendment of Revenue Laws Act 3 of 2026 s7, GG 54446, deemed from 1 April 2025;
 * SARS Guide to the Employment Tax Incentive, Issue 5, §5.1.2 fn 144).
 */
import { describe, it, expect } from 'vitest';
import { validateEti } from '@/modules/accounting/services/payroll/validationEngine';

const employee = { id: 'emp-1', firstName: 'Thandi', lastName: 'Mokoena' };

describe('validateEti - the ETI table is confirmed', () => {
  it('is silent for ETI claimed in a period from 1 April 2026', () => {
    expect(validateEti(employee, { isDeterminable: true, missingInputs: [] })).toEqual([]);
  });

  it('still reports an indeterminate result as before', () => {
    const out = validateEti(employee, { isDeterminable: false, missingInputs: ['date_of_birth'] });
    expect(out.map((w) => w.code)).toEqual(['ETI_INDETERMINATE']);
  });
});
