/**
 * Wave 6 PV: the three pre-validation surfaces. The compliance card lists each employee's issues with severity and a
 * fix link; the profile line names this employee's issues; run approval lists them as warnings and approval stays
 * possible (never a block). A 403 is the payroll-detail access message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

const st = vi.hoisted(() => ({ urls: [] as string[], pv: {} as unknown, fail: 0 }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiJson: vi.fn(async (url: string) => {
    st.urls.push(url);
    if (url.startsWith('/api/payroll/pre-validation')) {
      if (st.fail) { const { ApiRequestError: E } = await orig<typeof import('@/lib/apiFetch')>(); throw new E('Forbidden', st.fail); }
      return st.pv;
    }
    return { plan: { runId: 'r1', status: 'calculated', entryDate: '2026-12-31', periodMonth: 12, periodYear: 2026, lineCount: 1, paidEmployeeCount: 1,
      reference: 'PAY-1', lines: [], totals: { net: 1 }, totalDebit: 1, totalCredit: 1, advisories: [] }, posted: null, replaces: null, planHash: 'h', blocker: null };
  }),
}));

import { PreValidationCard } from '@/components/payroll/preValidation/PreValidationCard';
import { PreValidationLine } from '@/components/payroll/preValidation/PreValidationLine';
import { PayrollApproveDialog } from '@/components/payroll/PayrollApproveDialog';

afterEach(() => { cleanup(); st.urls = []; st.fail = 0; });

const issue = (severity: string, code: string, message: string, fixHref: string, fixLabel: string) =>
  ({ severity, code, message, field: null, fixHref, fixLabel });
const result = (over: Record<string, unknown> = {}) => ({
  taxYear: 2027, employeesChecked: 3, errors: 1, warnings: 1, codeReleaseLoaded: true,
  employees: [
    { employeeId: 'e1', employeeNumber: 'EMP-1', name: 'Thandi Nkosi', severity: 'error',
      issues: [issue('error', 'IRP5_MISSING_TAX_NUMBER', 'Missing tax number', '/payroll/employees/e1#employee-tax-number', 'Tax number')] },
    { employeeId: 'e2', employeeNumber: 'EMP-2', name: 'Sipho Dube', severity: 'warning',
      issues: [issue('warning', 'IRP5_INVALID_ID', 'ID number is not a 13-digit SA ID', '/payroll/employees/e2#employee-id-number', 'ID number')] },
  ],
  ...over,
});

describe('PreValidationCard (compliance hub)', () => {
  it('reads the tax year and lists each issue with its severity and fix link', async () => {
    st.pv = result();
    render(<PreValidationCard />);
    expect(await screen.findByTestId('pre-validation-summary')).toHaveProperty('textContent', '3 employees checked · 1 error · 1 warning');
    expect(st.urls[0]).toMatch(/^\/api\/payroll\/pre-validation\?taxYear=\d{4}$/);
    const fix = screen.getByRole('link', { name: 'Fix: Tax number' });
    expect(fix.getAttribute('href')).toBe('/payroll/employees/e1#employee-tax-number');
    expect(within(fix.closest('li')!).getByText('Error:')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Fix: ID number' }).getAttribute('href')).toBe('/payroll/employees/e2#employee-id-number');
    expect(screen.queryByText(/No SARS source-code release/)).toBeNull();
  });
  it('says the code checks are unconfirmed when no SARS code list is loaded for the year', async () => {
    st.pv = result({ codeReleaseLoaded: false });
    render(<PreValidationCard />);
    expect(await screen.findByText('No SARS source-code release is loaded for tax year 2027; the code checks for this year are not reliable.')).toBeTruthy();
  });
  it('a clean year says so', async () => {
    st.pv = result({ errors: 0, warnings: 0, employees: [] });
    render(<PreValidationCard />);
    expect(await screen.findByText('No issues found.')).toBeTruthy();
  });
  it('a 403 shows the payroll-detail access message', async () => {
    st.fail = 403;
    render(<PreValidationCard />);
    expect((await screen.findByRole('alert')).textContent).toBe("You don't have access to payroll detail.");
  });
});

describe('PreValidationLine (employee profile)', () => {
  it('names this employee\'s issues with the fix link', async () => {
    st.pv = result({ employeesChecked: 1, employees: [result().employees[0]] });
    render(<PreValidationLine employeeId="e1" />);
    const line = await screen.findByTestId('pre-validation-line');
    expect(st.urls).toEqual(['/api/payroll/pre-validation?employeeId=e1']);
    expect(line.textContent).toContain('Missing tax number');
    expect(within(line).getByRole('link', { name: 'Tax number' }).getAttribute('href')).toBe('/payroll/employees/e1#employee-tax-number');
  });
  it('draws nothing for an employee with no final pay run yet', async () => {
    st.pv = result({ employeesChecked: 0, employees: [] });
    const { container } = render(<PreValidationLine employeeId="e9" />);
    await vi.waitFor(() => expect(st.urls).toHaveLength(1));
    expect(container.textContent).toBe('');
  });
});

describe('Run approval', () => {
  it('lists the run\'s employees\' issues as warnings, and Approve stays enabled', async () => {
    st.pv = result();
    render(<PayrollApproveDialog runId="r1" period="Dec 2026" warningCount={0} open onClose={vi.fn()} onApproved={vi.fn()} onUncertain={vi.fn()} />);
    const box = await screen.findByTestId('pre-validation-run-warnings');
    expect(st.urls).toContain('/api/payroll/pre-validation?runId=r1');
    expect(box.textContent).toContain('2 employees on this run have 2 issues');
    expect(box.textContent).toContain('They do not block approval.');
    expect(box.textContent).toContain('Thandi Nkosi: Missing tax number');
    expect((screen.getByRole('button', { name: /Approve and post journal/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});

