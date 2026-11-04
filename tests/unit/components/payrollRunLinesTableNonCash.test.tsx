/**
 * The run's lines table shows a line's non-cash fringe benefit (the 3801 loan benefit): it is
 * taxed and levied but not in Gross, so PAYE and SDL on R42 000 beside a R41 000 gross need it on
 * screen. Shown under Gross and in its tooltip; Net's reconciliation is unchanged (cash only).
 */
import { render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { PayrollRunLinesTable, type RunLineAmounts } from '@/components/payroll/PayrollRunLinesTable';

afterEach(cleanup);

const line = (over: Partial<RunLineAmounts>): RunLineAmounts => ({
  employeeId: 'e-1', employeeNumber: 'E001', employeeName: 'Riaan Smit', grossPay: 41_000, paye: 9_000,
  uifEmployee: 177.12, uifEmployer: 177.12, sdl: 420, eti: 0, netPay: 31_722.88, ...over,
});

describe('PayrollRunLinesTable — non-cash benefits', () => {
  it('shows the benefit under the gross, says it is taxed but not paid, and leaves Gross and Net cash', () => {
    render(<PayrollRunLinesTable lines={[line({ nonCashBenefits: 1_000 })]} />);
    const note = screen.getByText(/\+ R 1 000\.00 non-cash/);
    expect(note.closest('td')!.getAttribute('title')).toMatch(/R\s1\s000\.00 non-cash benefit.*taxed.*not paid/);
    expect(note.closest('td')!.textContent).toMatch(/R\s41\s000\.00/);
    expect(screen.getAllByText('R 31 722.88').length).toBeGreaterThan(0);
  });

  it('shows nothing extra for a line without one', () => {
    render(<PayrollRunLinesTable lines={[line({})]} />);
    expect(screen.queryByText(/non-cash/)).toBeNull();
  });
});
