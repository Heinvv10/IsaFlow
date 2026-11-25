/**
 * Wave 7 EA1: the address on the employee create form. Optional; once typed it is checked by the server's own rules
 * (parseEmployeeAddress) on its field, before the employee is created, and saved through the one writer
 * (PUT /api/payroll/employees/[id]/address) once the employee exists. A failed address save says the employee was
 * saved and never creates a second one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
const push = vi.hoisted(() => vi.fn(async () => true));
vi.mock('next/router', () => ({ useRouter: () => ({ push, query: {}, pathname: '/' }) }));

import NewEmployeePage from '@/../pages/payroll/employees/new';

const EMP = '11111111-1111-4111-8111-111111111111';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fetchMock = vi.fn();
const sent = (method: string, part: string) =>
  fetchMock.mock.calls.filter(([u, i]) => String(u).includes(part) && (i as RequestInit | undefined)?.method === method);
function serve(address: Response = ok(null)) {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/address')) return address;
    if (u.endsWith('/api/payroll/employees') && init?.method === 'POST') return ok({ id: EMP });
    return ok([]);
  });
}
beforeEach(() => { fetchMock.mockReset(); push.mockClear(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fillEmployee = () => { fill('First name *', 'Kay'); fill('Last name *', 'One'); fill('Employee number *', 'EA1-1'); };
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Create Employee' }));

describe('address on create', () => {
  it('blank: no asterisks, no address call', async () => {
    serve();
    render(<NewEmployeePage />);
    expect(screen.getByLabelText('Street or farm name')).toBeTruthy();
    fillEmployee();
    submit();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/payroll/employees/${EMP}`));
    expect(sent('PUT', '/address')).toHaveLength(0);
  });

  it('typed but refused by the BRS rules: the field says why, focus goes there, nothing is created', async () => {
    serve();
    render(<NewEmployeePage />);
    fillEmployee();
    fill('Street or farm name', 'Main Road');
    fill('City or town', 'Pretoria');
    fill('Postal code', '28');
    submit();
    expect(await screen.findByText('A South African postal code is four digits and not 0000 (code 3217)')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByLabelText('Postal code'));
    expect(screen.getByLabelText('Street or farm name *')).toBeTruthy();
    expect(sent('POST', '/api/payroll/employees')).toHaveLength(0);
  });

  it('typed and valid: the employee first, then the address through the one writer', async () => {
    serve();
    render(<NewEmployeePage />);
    fillEmployee();
    fill('Street or farm name', 'Main Road');
    fill('City or town', 'Pretoria');
    fill('Postal code', '0028');
    submit();
    await waitFor(() => expect(push).toHaveBeenCalledWith(`/payroll/employees/${EMP}`));
    const [url, init] = sent('PUT', '/address')[0]!;
    expect(String(url)).toBe(`/api/payroll/employees/${EMP}/address`);
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      residential: { unitNumber: '', complex: '', streetNumber: '', street: 'Main Road', suburb: '', city: 'Pretoria', postalCode: '0028', countryCode: 'ZA' },
      postal: { sameAsResidential: true },
    });
    const order = fetchMock.mock.calls.map(([u, i]) => `${(i as RequestInit | undefined)?.method ?? 'GET'} ${String(u)}`)
      .filter((c) => c.startsWith('POST /api/payroll/employees') || c.startsWith('PUT '));
    expect(order).toEqual(['POST /api/payroll/employees', `PUT /api/payroll/employees/${EMP}/address`]);
  });

  it('the address save fails: says the employee is saved, offers the profile, never creates twice', async () => {
    serve(new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'Only a person signed in as themselves can read or change an employee\'s address.' } }), { status: 403 }));
    render(<NewEmployeePage />);
    fillEmployee();
    fill('Street or farm name', 'Main Road');
    fill('City or town', 'Pretoria');
    fill('Postal code', '0028');
    submit();
    expect((await screen.findByRole('alert')).textContent).toMatch(/Employee saved; address not saved: Only a person signed in as themselves .*Add it on the profile/);
    expect(screen.getByRole('link', { name: 'Open the profile' }).getAttribute('href')).toBe(`/payroll/employees/${EMP}`);
    expect(push).not.toHaveBeenCalled();
    expect(sent('POST', '/api/payroll/employees')).toHaveLength(1);
  });
});
