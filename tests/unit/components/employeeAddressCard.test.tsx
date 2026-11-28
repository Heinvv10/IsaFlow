/**
 * Wave 7 EA1: the profile's address card and the portal's read-only "Your details". The card shows the stored address,
 * offers Add / Change to owner / admin / manager only, refuses a bad address in the browser with the BRS message on
 * its field (no PUT), sends a good one, and shows the server's refusal. The portal section has no edit control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

const role = vi.hoisted(() => ({ current: 'manager' as string | null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: role.current }) }));

import { EmployeeAddressCard } from '@/components/payroll/EmployeeAddressCard';
import { DetailsSection } from '@/components/employeePortal/DetailsSection';

const EMP = '11111111-1111-4111-8111-111111111111';
const ADDRESS = {
  residential: { unitNumber: null, complex: null, streetNumber: '12', street: 'Main Road', suburb: 'Hatfield', city: 'Pretoria', postalCode: '0028', countryCode: 'ZA' },
  postal: { sameAsResidential: false, line1: 'PO Box 9', line2: 'Hatfield', line3: null, line4: null, postalCode: '0028', countryCode: 'ZA' },
};
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fetchMock = vi.fn();
const puts = () => fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT');
function serve(stored: unknown, put?: Response) {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => (init?.method === 'PUT' ? put ?? ok(ADDRESS) : ok(stored)));
}
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); role.current = 'manager'; });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('the profile address card', () => {
  it('shows the stored residential and postal lines and offers Change to a manager', async () => {
    serve(ADDRESS);
    render(<EmployeeAddressCard employeeId={EMP} />);
    expect(await screen.findByText('12 Main Road')).toBeTruthy();
    expect(screen.getByText('PO Box 9')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change address' })).toBeTruthy();
    expect(String(fetchMock.mock.calls[0]![0])).toBe(`/api/payroll/employees/${EMP}/address`);
  });

  it('a viewer sees no Add / Change button', async () => {
    role.current = 'viewer';
    serve(null);
    render(<EmployeeAddressCard employeeId={EMP} />);
    expect(await screen.findByText(/No address yet/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /address/ })).toBeNull();
  });

  it('refuses a bad ZA postal code on its field without a PUT, then saves a good one', async () => {
    serve(null);
    render(<EmployeeAddressCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Add address' }));
    fireEvent.change(screen.getByLabelText('Street or farm name *'), { target: { value: 'Main Road' } });
    fireEvent.change(screen.getByLabelText('City or town'), { target: { value: 'Pretoria' } });
    fireEvent.change(screen.getByLabelText('Postal code'), { target: { value: '28' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect(await screen.findByText('A South African postal code is four digits and not 0000 (code 3217)')).toBeTruthy();
    expect(puts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('Postal code'), { target: { value: '0028' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    await waitFor(() => expect(puts()).toHaveLength(1));
    expect(JSON.parse(String((puts()[0]![1] as RequestInit).body))).toEqual({
      residential: { unitNumber: '', complex: '', streetNumber: '', street: 'Main Road', suburb: '', city: 'Pretoria', postalCode: '0028', countryCode: 'ZA' },
      postal: { sameAsResidential: true },
    });
  });

  it('shows the server refusal as sent', async () => {
    serve(ADDRESS, new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN', message: 'You cannot read or change an employee\'s address while impersonating another user.' } }), { status: 403 }));
    render(<EmployeeAddressCard employeeId={EMP} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Change address' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save address' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/while impersonating/);
  });
});

describe('the portal "Your details"', () => {
  it('shows the address and the bank as name + last four, with no edit control', () => {
    render(<DetailsSection address={ADDRESS as never} bank={{ bankName: 'FNB', accountLast4: '3456' }} />);
    expect(screen.getByRole('heading', { name: 'Your details' })).toBeTruthy();
    expect(screen.getByText('12 Main Road')).toBeTruthy();
    expect(screen.getByText('PO Box 9')).toBeTruthy();
    expect(screen.getByText('Account ending 3456')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText(/ask your employer/)).toBeTruthy();
  });

  it('says "Not on record" for what the employer does not hold', () => {
    render(<DetailsSection address={null} bank={null} />);
    expect(screen.getAllByText('Not on record')).toHaveLength(3);
  });
});
