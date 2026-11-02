/**
 * The run page lists a recurring component needing a manual pro-rata (RECURRING_NEEDS_PRO_RATA) under its own heading
 * and says it blocks approval; the other warnings still say they do not.
 */
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { PayrollRunWarnings } from '@/components/payroll/PayrollRunWarnings';

afterEach(cleanup);

const proRata = {
  code: 'RECURRING_NEEDS_PRO_RATA', severity: 'error' as const,
  message: 'Basic Salary starts on 2026-03-30: this recurring component is paid in full in this run and needs a manual pro-rata.',
};
const noTax = { code: 'MISSING_TAX_NUMBER', severity: 'error' as const, message: 'No tax number' };

describe('PayrollRunWarnings', () => {
  it('names the pro-rata group and the employee, and says it blocks approval', () => {
    render(<PayrollRunWarnings lines={[{ employeeId: 'e1', employeeName: 'Thandi Mokoena', validationResults: [proRata] }]} />);
    expect(screen.getByText(/needs a manual pro-rata; approval is refused until its dates are changed/i)).toBeTruthy();
    expect(screen.getByText('Thandi Mokoena').getAttribute('title')).toContain('starts on 2026-03-30');
    expect(screen.getByText(/pro-rata blocks approval/i)).toBeTruthy();
    expect(screen.queryByText(/These do not block the run/i)).toBeNull();
  });

  it('without it, the warnings still say they do not block', () => {
    render(<PayrollRunWarnings lines={[{ employeeId: 'e1', employeeName: 'Thandi Mokoena', validationResults: [noTax] }]} />);
    expect(screen.getByText(/These do not block the run/i)).toBeTruthy();
    expect(screen.queryByText(/pro-rata blocks approval/i)).toBeNull();
  });
});
