/**
 * Payroll-run warnings must reach the read path, not just the column.
 *
 * `calculatePayrollRun` has always written `[...empValidation, ...lineValidation]`
 * into `payroll_run_lines.validation_results`, and `getPayrollRunLines` selects
 * `prl.*` — but its mapper dropped the field on the floor. Nothing in src/ or
 * pages/ read the column. So every warning the validation engine has ever
 * produced (MISSING_BANK_DETAILS included) was written and then discarded one
 * function later.
 *
 * Adding the new ETI warning to that column alone would have replaced one silent
 * failure with another, so the mapper has to expose it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

import { sql } from '@/lib/neon';
import { getPayrollRunLines } from '@/modules/accounting/services/payroll/payrollRunService';

const RUN_ID = '11111111-1111-1111-1111-111111111111';
const COMPANY_ID = '22222222-2222-2222-2222-222222222222';

const ETI_WARNING = {
  code: 'ETI_INDETERMINATE',
  severity: 'warning',
  message: 'ETI eligibility could not be determined for Thandi Mokoena — date of birth is missing.',
  field: 'dateOfBirth',
  deepLink: '/payroll/employees/emp-1#date-of-birth',
};

function row(validationResults: unknown) {
  return {
    id: 'line-1', run_id: RUN_ID, employee_id: 'emp-1',
    employee_number: 'E001', first_name: 'Thandi', last_name: 'Mokoena',
    gross_pay: '3000', taxable_income: '3000', paye: '0',
    uif_employee: '30', uif_employer: '30', sdl: '30', eti: '0', net_pay: '2970',
    validation_results: validationResults,
  };
}

describe('getPayrollRunLines — validation warnings reach the caller', () => {
  beforeEach(() => vi.clearAllMocks());

  it('exposes the stored validation results on each line', async () => {
    vi.mocked(sql).mockResolvedValueOnce([row([ETI_WARNING])] as never);

    const lines = await getPayrollRunLines(RUN_ID, COMPANY_ID);

    expect(lines).toHaveLength(1);
    expect(lines[0]!.validationResults).toHaveLength(1);
    expect(lines[0]!.validationResults[0]!.code).toBe('ETI_INDETERMINATE');
    expect(lines[0]!.validationResults[0]!.severity).toBe('warning');
    expect(lines[0]!.validationResults[0]!.message).toContain('Thandi Mokoena');
  });

  it('accepts the column as a JSON string as well as parsed jsonb', async () => {
    // pg returns jsonb parsed, but a text column or a driver change would hand
    // back a string — degrade to [] rather than crashing the run detail page.
    vi.mocked(sql).mockResolvedValueOnce([row(JSON.stringify([ETI_WARNING]))] as never);

    const lines = await getPayrollRunLines(RUN_ID, COMPANY_ID);
    expect(lines[0]!.validationResults[0]!.code).toBe('ETI_INDETERMINATE');
  });

  it('returns an empty array for NULL, malformed or non-array values', async () => {
    for (const bad of [null, undefined, 'not json', '{"a":1}', 42]) {
      vi.mocked(sql).mockResolvedValueOnce([row(bad)] as never);
      const lines = await getPayrollRunLines(RUN_ID, COMPANY_ID);
      expect(lines[0]!.validationResults).toEqual([]);
    }
  });

  it('still scopes the query by company_id', async () => {
    vi.mocked(sql).mockResolvedValueOnce([row([])] as never);
    await getPayrollRunLines(RUN_ID, COMPANY_ID);

    const call = vi.mocked(sql).mock.calls[0]!;
    const text = (call[0] as TemplateStringsArray).join('?');
    expect(text).toContain('company_id');
    expect(call.slice(1)).toContain(COMPANY_ID);
  });
});
