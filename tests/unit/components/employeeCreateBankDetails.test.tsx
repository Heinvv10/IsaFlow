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

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
function fillEmployee() {
  fill('First name *', 'Kay'); fill('Last name *', 'One'); fill('Employee number *', 'K2-1');
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create Employee' }));

describe('bank details on create', () => {
  it('posts the bank details to the new employee after the employee, then opens the profile', async () => {
    serve(ok({ id: 'b1' }));
    render(<NewEmployeePage />);
    fillEmployee();
    fill('Bank name *', 'FNB'); fill('Branch code *', '250655'); fill('Account number *', '62000123456');
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

  it('a half-filled section stops the submit on the field, with nothing created', async () => {
    serve(ok({ id: 'b1' }));
    render(<NewEmployeePage />);
    fillEmployee();
    fill('Bank name *', 'FNB');
    submit();
    await waitFor(() => expect(screen.getByLabelText('Account number *').getAttribute('aria-invalid')).toBe('true'));
    expect(sent('POST', '/api/payroll/employees')).toHaveLength(0);
  });

  it('when the bank call fails: says the employee is saved and why, links the profile, and cannot create twice', async () => {
    serve(refusal('Account number must be 6 to 16 digits'));
    render(<NewEmployeePage />);
    fillEmployee();
    fill('Bank name *', 'FNB'); fill('Branch code *', '250655'); fill('Account number *', '62000123456');
    submit();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Employee saved; bank details not saved: Account number must be 6 to 16 digits. Add them on the profile.');
    expect(push).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Open the profile' }).getAttribute('href')).toBe(`/payroll/employees/${EMP}`);
    expect(screen.queryByRole('button', { name: 'Create Employee' })).toBeNull();
    expect(sent('POST', '/api/payroll/employees')).toHaveLength(1);
  });
});
