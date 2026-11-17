/** EmployeeEmailField (wave 6 PE): loads the address, saves it trimmed through its own route, and shows a refusal. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { EmployeeEmailField } from '@/components/payroll/EmployeeEmailField';

const fetchMock = vi.fn();
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EmployeeEmailField', () => {
  it('loads the address, saves only when changed, trimmed, and shows what the server stored', async () => {
    fetchMock.mockResolvedValueOnce(ok({ email: 'old@example.invalid' }));
    render(<EmployeeEmailField employeeId="e1" canEdit />);
    const input = await screen.findByDisplayValue('old@example.invalid');
    expect(screen.getByRole('button', { name: 'Save email' })).toBeDisabled();
    fetchMock.mockResolvedValueOnce(ok({ email: 'new@example.invalid' }));
    fireEvent.change(input, { target: { value: '  new@example.invalid ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email' }));
    await screen.findByText('Payslip email saved.');
    const [url, init] = fetchMock.mock.calls[1]!;
    expect(url).toBe('/api/payroll/employees/e1/email');
    expect(init.method).toBe('PUT');
    expect(JSON.parse(init.body)).toEqual({ email: 'new@example.invalid' });
  });

  it('read-only for a role that may not set it: no save button, a note says who can', async () => {
    fetchMock.mockResolvedValueOnce(ok({ email: 'old@example.invalid' }));
    render(<EmployeeEmailField employeeId="e1" canEdit={false} />);
    expect(await screen.findByDisplayValue('old@example.invalid')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save email' })).toBeNull();
    expect(screen.getByText('Only an owner or admin can set where payslips are emailed.')).toBeTruthy();
  });

  it('shows the server refusal and keeps the typed value', async () => {
    fetchMock.mockResolvedValueOnce(ok({ email: 'old@example.invalid' }));
    render(<EmployeeEmailField employeeId="e1" canEdit />);
    const input = await screen.findByDisplayValue('old@example.invalid');
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN',
      message: "Only an owner or admin can change an employee's payslip email once it is set." } }), { status: 403 }));
    fireEvent.change(input, { target: { value: 'mine@example.invalid' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save email' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Only an owner or admin'));
    expect(screen.getByDisplayValue('mine@example.invalid')).toBeTruthy();
  });
});
