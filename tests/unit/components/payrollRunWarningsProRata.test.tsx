/**
 * The run page lists a recurring component needing a manual pro-rata (RECURRING_NEEDS_PRO_RATA) under its own heading
 * and says it blocks approval; the other warnings still say they do not. The page shows each employee's own message
 * for it (runWarningCodes.OWN_FIGURES: the component and its dates), in the text, not only in a tooltip.
 */
import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';

import { PayrollRunWarnings } from '@/components/payroll/PayrollRunWarnings';

afterEach(cleanup);

const proRata = {
  code: 'RECURRING_NEEDS_PRO_RATA', severity: 'error' as const, deepLink: '/payroll/employees/e1#pay-components',
  message: 'Basic Salary starts on 2026-03-30: this recurring component is paid in full in this run and needs a manual pro-rata.',
};
const noTax = { code: 'MISSING_TAX_NUMBER', severity: 'error' as const, message: 'No tax number' };

describe('PayrollRunWarnings', () => {
  it('names the pro-rata group and the employee, and says it blocks approval', () => {
    render(<PayrollRunWarnings lines={[{ employeeId: 'e1', employeeName: 'Thandi Mokoena', validationResults: [proRata] }]} />);
    expect(screen.getByText(/needs a manual pro-rata: use Edit dates on the employee's Pay Components, then recalculate/i)).toBeTruthy();
    expect(screen.getByText('Thandi Mokoena').closest('a')!.getAttribute('href')).toBe('/payroll/employees/e1#pay-components');
    expect(screen.getByText(/starts on 2026-03-30/)).toBeTruthy();
    expect(screen.getByText(/Blocks approval:/)).toBeTruthy();
    expect(screen.queryByText(/do not block approval/i)).toBeNull();
  });

  it('without it, the warnings still say they do not block', () => {
    render(<PayrollRunWarnings lines={[{ employeeId: 'e1', employeeName: 'Thandi Mokoena', validationResults: [noTax] }]} />);
    expect(screen.getByText(/do not block approval/i)).toBeTruthy();
    expect(screen.queryByText(/Blocks approval/)).toBeNull();
  });
});
