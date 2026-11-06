/** Wave 4 B: the profile's "Ready to pay" card, and the one line in the employee drawer. Bank is read masked only. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, cleanup, waitFor, fireEvent } from '@testing-library/react';
import { EmployeeReadinessCard } from '@/components/payroll/EmployeeReadinessCard';
import { EmployeeDrawerBody } from '@/components/payroll/EmployeeDrawerBody';

const EMP = '11111111-1111-4111-8111-111111111111';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (status: number) => new Response(JSON.stringify({ success: false, error: { message: 'no' } }), { status });
const salary = { componentType: 'earning', isTaxable: true, isRecurring: true, componentActive: true, effectiveFrom: '2020-01-01', effectiveTo: null };
const fetchMock = vi.fn();
const urls = () => fetchMock.mock.calls.map(([u]) => String(u));

beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const props = { employeeId: EMP, employee: { taxNumber: '0123456789', paymentMethod: 'eft' }, assignments: [salary] };

describe('EmployeeReadinessCard', () => {
  it('says "Ready to pay" once the masked bank read answers with details', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'b1', accountNumber: '…1234' }));
    render(<EmployeeReadinessCard {...props} />);
    expect(await screen.findByText('Ready to pay')).toBeTruthy();
    expect(urls()).toEqual([`/api/payroll/employees/${EMP}/bank-details?view=masked`]);
  });

  it('does not claim ready while the bank read is in flight', async () => {
    fetchMock.mockReturnValue(new Promise(() => {}));
    render(<EmployeeReadinessCard {...props} />);
    expect(screen.queryByText('Ready to pay')).toBeNull();
    expect(screen.getByText('Checking…')).toBeTruthy();
  });

  it('lists what is missing as links to the fields', async () => {
    fetchMock.mockResolvedValue(ok(null));
    render(<EmployeeReadinessCard {...props} employee={{ taxNumber: '' }} assignments={[]} />);
    expect(await screen.findByText('3 things before the first pay run: a valid tax number, a salary, bank details')).toBeTruthy();
    const links = screen.getAllByRole('link');
    expect(links.map(l => l.getAttribute('href'))).toEqual(['#employee-tax-number', '#employee-pay', '#employee-bank']);
  });

  it('a link focuses the field it names', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'b1' }));
    render(<><input id="employee-tax-number" aria-label="Tax number" /><EmployeeReadinessCard {...props} employee={{ taxNumber: '' }} /></>);
    fireEvent.click(await screen.findByRole('link', { name: 'a valid tax number' }));
    expect(document.activeElement).toBe(screen.getByLabelText('Tax number'));
  });

  it('cash without bank details is ready', async () => {
    fetchMock.mockResolvedValue(ok(null));
    render(<EmployeeReadinessCard {...props} employee={{ taxNumber: '0123456789', paymentMethod: 'cash' }} />);
    expect(await screen.findByText('Ready to pay')).toBeTruthy();
  });

  it('a failed bank read does not claim bank details are missing', async () => {
    fetchMock.mockResolvedValue(fail(500));
    render(<EmployeeReadinessCard {...props} />);
    await waitFor(() => expect(screen.queryByText('Checking…')).toBeNull());
    expect(screen.queryByText(/bank details/)).toBeNull();
  });

  it('reads the bank again when the refresh key changes', async () => {
    fetchMock.mockResolvedValueOnce(ok(null)).mockResolvedValueOnce(ok({ id: 'b1' }));
    const { rerender } = render(<EmployeeReadinessCard {...props} refreshKey={0} />);
    expect(await screen.findByText(/1 thing before the first pay run: bank details/)).toBeTruthy();
    rerender(<EmployeeReadinessCard {...props} refreshKey={1} />);
    expect(await screen.findByText('Ready to pay')).toBeTruthy();
  });
});

describe('EmployeeDrawerBody readiness line', () => {
  const employee = { id: EMP, employeeNumber: 'E-1', employmentType: 'permanent', startDate: '2026-03-01', taxNumber: '0123456789', paymentMethod: 'eft' };
  const serve = (bank: Response) => fetchMock.mockImplementation(async (u: string) => {
    if (u.includes('/bank-details')) return bank;
    if (u.endsWith('/components')) return ok([{ ...salary, id: 'x', componentId: 'c', componentName: 'Basic', amount: 100 }]);
    return ok(employee);
  });

  it('shows the verdict line for a writer', async () => {
    serve(ok(null));
    render(<EmployeeDrawerBody employeeId={EMP} mayWrite />);
    expect(await screen.findByText('1 thing before the first pay run: bank details')).toBeTruthy();
  });

  it('shows no line, and reads no bank, for a names-only role', async () => {
    serve(ok(null));
    render(<EmployeeDrawerBody employeeId={EMP} mayWrite={false} />);
    await screen.findByText('Employee number');
    expect(screen.queryByText(/pay run|Ready to pay/)).toBeNull();
    expect(urls().some(u => u.includes('bank-details'))).toBe(false);
  });
});
