/**
 * PayrollRunWarnings groups a run's line results by code. A group whose employees carry different
 * messages (each names their own loan and amount) shows every employee's own message; a heading is a
 * label, never one employee's message. Results the approval gate refuses on are counted and worded as
 * blocking, not as warnings.
 */
import { describe, it, expect, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, within } from '@testing-library/react';
import { PayrollRunWarnings, type RunLineWarning } from '@/components/payroll/PayrollRunWarnings';

afterEach(cleanup);

const line = (id: string, name: string, results: RunLineWarning[]) => ({ employeeId: id, employeeName: name, validationResults: results });
const result = (code: string, message: string, severity: RunLineWarning['severity'] = 'warning'): RunLineWarning => ({ code, message, severity });
const LOAN_A = 'Loan QA-LOAN-A (instalment R 1 000.00): no active deduction coded LOAN, so the instalment was not taken and the loan is unchanged.';
const LOAN_B = 'Loan QA-LOAN-B (instalment R 500.00): no active deduction coded LOAN, so the instalment was not taken and the loan is unchanged.';
const groupOf = (label: RegExp) => screen.getByText(label).closest('li')!;

describe('PayrollRunWarnings', () => {
  it.each([
    ['LOAN_DEDUCTION_MISSING', /Loan instalment not taken/, 'error'],
    ['LOAN_FRINGE_NOT_RECORDED', /fringe benefit not recorded/, 'warning'],
  ] as const)('%s: its own heading, and each employee with their own loan', (code, label, severity) => {
    render(<PayrollRunWarnings lines={[
      line('e1', 'Zanele Grid', [result(code, LOAN_A, severity)]),
      line('e2', 'Pieter Grid', [result(code, LOAN_B, severity)]),
    ]} />);
    const group = groupOf(label);
    expect(within(group).queryByText(LOAN_A, { exact: false })).not.toBe(group);
    const zanele = within(group).getByText('Zanele Grid').closest('li')!;
    const pieter = within(group).getByText('Pieter Grid').closest('li')!;
    expect(zanele.textContent).toContain('QA-LOAN-A');
    expect(zanele.textContent).not.toContain('QA-LOAN-B');
    expect(pieter.textContent).toContain('QA-LOAN-B');
    expect(pieter.textContent).not.toContain('QA-LOAN-A');
  });

  it('an unknown code with different messages is never headed by one employee\'s message', () => {
    render(<PayrollRunWarnings lines={[
      line('e1', 'Zanele Grid', [result('SOMETHING_NEW', 'About Zanele: R 10')]),
      line('e2', 'Pieter Grid', [result('SOMETHING_NEW', 'About Pieter: R 20')]),
    ]} />);
    const pieter = screen.getByText('Pieter Grid').closest('li')!;
    expect(pieter.textContent).toContain('About Pieter: R 20');
    expect(pieter.textContent).not.toContain('About Zanele');
    expect(screen.getAllByText(/About Zanele/)).toHaveLength(1); // her own row, not the heading too
  });

  it('a blocking result: the panel says it blocks approval, and does not count it as a warning', () => {
    render(<PayrollRunWarnings lines={[
      line('e1', 'Zanele Grid', [result('LOAN_DEDUCTION_MISSING', LOAN_A, 'error'), result('MISSING_TAX_NUMBER', 'No tax number', 'error')]),
    ]} />);
    expect(screen.queryByText(/do not block the run/)).toBeNull();
    expect(screen.getByRole('heading').textContent).toBe('1 issue blocks approval · 1 warning');
    expect(screen.getByText(/must be resolved before this run can be approved/)).toBeTruthy();
  });

  it.each(['DEDUCTIONS_EXCEED_PAY', 'LOAN_DEDUCTION_MISSING'])('%s is blocking', (code) => {
    render(<PayrollRunWarnings lines={[line('e1', 'Zanele Grid', [result(code, 'x', 'error')])]} />);
    expect(screen.getByRole('heading').textContent).toBe('1 issue blocks approval');
  });

  it('nothing blocking: the warnings do not block, and say so', () => {
    render(<PayrollRunWarnings lines={[
      line('e1', 'Zanele Grid', [result('LOAN_FRINGE_NOT_RECORDED', LOAN_A), result('LOAN_INSTALMENT_EXCEEDS_PAY', 'over')]),
    ]} />);
    expect(screen.getByRole('heading').textContent).toBe('2 warnings on this run');
    expect(screen.getByText(/These do not block the run/)).toBeTruthy();
  });

  it('the same message for everyone stays one line of names', () => {
    render(<PayrollRunWarnings lines={[
      line('e1', 'Zanele Grid', [result('MISSING_TAX_NUMBER', 'No tax number')]),
      line('e2', 'Pieter Grid', [result('MISSING_TAX_NUMBER', 'No tax number')]),
    ]} />);
    const group = groupOf(/No SARS tax number/);
    expect(group.textContent).toContain('2 employees: Zanele Grid, Pieter Grid');
  });
});
