/**
 * Wave 6 PV: the three pre-validation surfaces. The compliance card lists each employee's issues with severity and a
 * fix link; the profile line names this employee's issues; run approval lists them as warnings and approval stays
 * possible (never a block). A 403 is the payroll-detail access message.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

const st = vi.hoisted(() => ({ urls: [] as string[], pv: {} as unknown, byUrl: {} as Record<string, unknown>, fail: 0, reason: '' }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  // The pre-validation reads go through apiFetch (to read a refusal's reason); everything else through apiJson.
  apiFetch: vi.fn(async (url: string) => {
    st.urls.push(url);
    if (st.fail) {
      const error = { message: 'Your role (viewer) does not allow viewing payroll detail.', ...(st.reason ? { details: { reason: st.reason } } : {}) };
      return new Response(JSON.stringify({ success: false, error }), { status: st.fail });
    }
    return new Response(JSON.stringify({ success: true, data: st.byUrl[url] ?? st.pv }), { status: 200 });
  }),
  apiJson: vi.fn(async () => ({ plan: { runId: 'r1', status: 'calculated', entryDate: '2026-12-31', periodMonth: 12, periodYear: 2026, lineCount: 1, paidEmployeeCount: 1,
    reference: 'PAY-1', lines: [], totals: { net: 1 }, totalDebit: 1, totalCredit: 1, advisories: [] }, posted: null, replaces: null, planHash: 'h', blocker: null })),
}));

import { PreValidationCard } from '@/components/payroll/preValidation/PreValidationCard';
import { PreValidationLine } from '@/components/payroll/preValidation/PreValidationLine';
import { PayrollApproveDialog } from '@/components/payroll/PayrollApproveDialog';

afterEach(() => { cleanup(); vi.useRealTimers(); st.urls = []; st.byUrl = {}; st.fail = 0; st.reason = ''; });

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
    expect(within(fix.closest('li')!).getByText('Must fix:')).toBeTruthy();
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

describe('PreValidationLine focuses the field a fix link names (L6)', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); });
  const withFields = () => render(
    <div><PreValidationLine employeeId="e1" /><input id="employee-tax-number" aria-label="Tax number" /><input id="employee-id-number" aria-label="ID number" /></div>,
  );
  it('arriving with #employee-id-number focuses the ID number field', async () => {
    st.pv = result({ employeesChecked: 0, employees: [] });
    window.history.replaceState(null, '', '/payroll/employees/e1#employee-id-number');
    withFields();
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('ID number')));
  });
  it('a hash change to #employee-tax-number focuses that field; an unrelated hash focuses nothing', async () => {
    st.pv = result({ employeesChecked: 0, employees: [] });
    window.history.replaceState(null, '', '/payroll/employees/e1#employee-bank');
    withFields();
    expect(document.activeElement).toBe(document.body);
    window.location.hash = '#employee-tax-number';
    window.dispatchEvent(new HashChangeEvent('hashchange'));
    await vi.waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Tax number')));
  });
});

describe('Login-as and agent sessions (refused by design): nothing is drawn', () => {
  const dialog = () => render(<PayrollApproveDialog runId="r1" period="Dec 2026" warningCount={0} open onClose={vi.fn()} onApproved={vi.fn()} onUncertain={vi.fn()} />);
  it.each(['IMPERSONATION_FORBIDDEN', 'AGENT_FORBIDDEN'])('%s: the card, the profile line and the dialog say nothing', async (reason) => {
    st.fail = 403;
    st.reason = reason;
    const card = render(<PreValidationCard />);
    await vi.waitFor(() => expect(st.urls).toHaveLength(1));
    await new Promise((done) => setTimeout(done, 30));
    expect(card.container.textContent).toBe('');
    card.unmount();
    const line = render(<PreValidationLine employeeId="e1" />);
    await vi.waitFor(() => expect(st.urls).toHaveLength(2));
    await new Promise((done) => setTimeout(done, 30));
    expect(line.container.textContent).toBe('');
    line.unmount();
    dialog();
    await screen.findByRole('button', { name: /Approve and post journal/ });
    await vi.waitFor(() => expect(st.urls).toContain('/api/payroll/pre-validation?runId=r1'));
    await new Promise((done) => setTimeout(done, 30));
    expect(screen.queryByText(/IRP5 checks/)).toBeNull();
    expect(screen.queryByText(/does not allow/)).toBeNull();
  });
  it('a role 403 (no such reason) still shows the access message on the card', async () => {
    st.fail = 403;
    render(<PreValidationCard />);
    expect((await screen.findByRole('alert')).textContent).toBe("You don't have access to payroll detail.");
  });
});

describe('useFocusHashField with a malformed hash', () => {
  afterEach(() => { window.history.replaceState(null, '', '/'); });
  it('#%E0%A4%A neither throws nor focuses: the profile line still renders', async () => {
    st.pv = result({ employeesChecked: 1, employees: [result().employees[0]] });
    window.history.replaceState(null, '', '/payroll/employees/e1#%E0%A4%A');
    render(<div><PreValidationLine employeeId="e1" /><input id="employee-id-number" aria-label="ID number" /></div>);
    expect(await screen.findByTestId('pre-validation-line')).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
  });
});

describe('PreValidationLine in the filing season (L4)', () => {
  const noLine = () => result({ employeesChecked: 0, errors: 0, warnings: 0, employees: [] });
  it('March to May, with no final line this year yet: shows the previous tax year', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-04-15T10:00:00Z'));
    st.byUrl['/api/payroll/pre-validation?employeeId=e1'] = noLine();
    st.byUrl['/api/payroll/pre-validation?employeeId=e1&taxYear=2027'] = result({ taxYear: 2027, employeesChecked: 1, employees: [result().employees[0]] });
    render(<PreValidationLine employeeId="e1" />);
    const line = await screen.findByTestId('pre-validation-line');
    expect(line.textContent).toContain('IRP5 checks (2027 tax year): Missing tax number');
  });
  it('outside March to May: stays silent and asks for no other year', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2027-08-15T10:00:00Z'));
    st.byUrl['/api/payroll/pre-validation?employeeId=e1'] = noLine();
    const { container } = render(<PreValidationLine employeeId="e1" />);
    await vi.waitFor(() => expect(st.urls).toHaveLength(1));
    // Let the answer land and any second read start.
    await new Promise((done) => setTimeout(done, 50));
    expect(container.textContent).toBe('');
    expect(st.urls).toEqual(['/api/payroll/pre-validation?employeeId=e1']);
  });
});

describe('Run approval', () => {
  it('warning shown, no blocker: Approve and post journal is enabled (the warnings never block)', async () => {
    st.pv = result();
    render(<PayrollApproveDialog runId="r1" period="Dec 2026" warningCount={0} open onClose={vi.fn()} onApproved={vi.fn()} onUncertain={vi.fn()} />);
    await screen.findByTestId('pre-validation-run-warnings');
    expect(screen.queryByText(/blocks approval/)).toBeNull();
    expect((screen.getByRole('button', { name: /Approve and post journal/ }) as HTMLButtonElement).disabled).toBe(false);
  });
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

