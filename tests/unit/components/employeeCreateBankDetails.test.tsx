/**
 * K2: bank details on the employee create form post as a second call once the employee exists. If that call fails
 * the form says the employee was saved and why the details were not, and does not create a second employee.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const push = vi.hoisted(() => vi.fn(async () => true));
vi.mock('next/router', () => ({ useRouter: () => ({ push, query: {}, pathname: '/' }) }));

import NewEmployeePage from '@/../pages/payroll/employees/new';

const EMP = '11111111-1111-4111-8111-111111111111';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refusal = (message: string) => new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message } }), { status: 403 });
const fetchMock = vi.fn();
const sent = (method: string, part: string) =>
  fetchMock.mock.calls.filter(([u, i]) => String(u).includes(part) && (i as RequestInit | undefined)?.method === method);

function serve(bank: Response) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.includes('/bank-details')) return bank;
    if (u.endsWith('/api/payroll/employees') && init?.method === 'POST') return ok({ id: EMP });
    return ok([]);
  });
}
beforeEach(() => { fetchMock.mockReset(); push.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// The bank labels are starred only once the section has something in it (employeeBankLabels.test.tsx): `fill` takes the
// exact label the field has at that moment, with no fallback to the other spelling.
const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
/** The first bank field typed makes the other two starred, so the first is typed unstarred and the rest starred. */
function fillBank(name: string, branch: string, account: string) {
  fill('Bank name', name); fill('Branch code *', branch); fill('Account number *', account);
}
function fillEmployee() {
  fill('First name *', 'Kay'); fill('Last name *', 'One'); fill('Employee number *', 'K2-1');
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create Employee' }));

describe('bank details on create', () => {
  it('posts the bank details to the new employee after the employee, then opens the profile', async () => {
    serve(ok({ id: 'b1' }));
    render(<NewEmployeePage />);
    fillEmployee();
    fillBank('FNB', '250655', '62000123456');
    submit();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/payroll/employees/${EMP}`));
    const [url, init] = sent('PUT', '/bank-details')[0]!;
    expect(String(url)).toBe(`/api/payroll/employees/${EMP}/bank-details`);
    expect(JSON.parse((init as RequestInit).body as string)).toMatchObject({ bankName: 'FNB', branchCode: '250655', accountNumber: '62000123456', accountType: 'cheque' });
  });

  it('leaves the second call out when the section is blank', async () => {
    serve(ok({ id: 'b1' }));
    render(<NewEmployeePage />);
    fillEmployee();
    submit();
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(sent('PUT', '/bank-details')).toHaveLength(0);
  });

  it.each([
    ['bank name only', { 'Bank name *': 'FNB' }, ['Branch code *', 'Account number *']],
    ['branch code only', { 'Branch code *': '250655' }, ['Bank name *', 'Account number *']],
    ['a short branch code', { 'Bank name *': 'FNB', 'Branch code *': '123', 'Account number *': '62000123456' }, ['Branch code *']],
  ])('a half-filled section (%s) stops the submit on the fields, with nothing created', async (_n, typed, invalid) => {
    serve(ok({ id: 'b1' }));
    render(<NewEmployeePage />);
    fillEmployee();
    // The first key typed starts the section, so it still reads unstarred; the rest are starred by then.
    Object.entries(typed).forEach(([label, value], i) => fill(i === 0 ? label.replace(/ \*$/, '') : label, value));
    submit();
    await waitFor(() => { for (const l of invalid) expect(screen.getByLabelText(l).getAttribute('aria-invalid')).toBe('true'); });
    expect(sent('POST', '/api/payroll/employees')).toHaveLength(0);
  });

  it('when the bank call fails: says the employee is saved and why, links the profile, and cannot create twice', async () => {
    serve(refusal('Account number must be 6 to 16 digits'));
    render(<NewEmployeePage />);
    fillEmployee();
    fillBank('FNB', '250655', '62000123456');
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Employee saved; bank details not saved: Account number must be 6 to 16 digits. Add them on the profile.');
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open the profile' }).getAttribute('href')).toBe(`/payroll/employees/${EMP}`);
    expect(screen.queryByRole('button', { name: 'Create Employee' })).toBeNull();
    expect(sent('POST', '/api/payroll/employees')).toHaveLength(1);
    // The employee exists: a field edited now would be discarded, so the form is read-only.
    expect(screen.getByLabelText('First name *').closest('fieldset')?.disabled).toBe(true);
    expect(screen.getByLabelText('Account number *').closest('fieldset')?.disabled).toBe(true);
  });

  it('a reason that already ends in a full stop does not double it', async () => {
    serve(refusal('Only an owner or admin can enter bank details.'));
    render(<NewEmployeePage />);
    fillEmployee();
    fillBank('FNB', '250655', '62000123456');
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('bank details not saved: Only an owner or admin can enter bank details. Add them on the profile.');
    expect(alert.textContent).not.toContain('..');
  });
});
