/**
 * PAYE 4a follow-ups round 2, R4: the new-directive form picks the payroll
 * employee the directive is paid to (required; leavers included, since
 * severance, retirement and death directives are for people who have left),
 * pre-fills the name and tax number from that employee, and sends employee_id.
 * Without it a directive made here could be paid by neither a run nor /apply.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { CreateTaxDirectiveModal } from '@/components/payroll/TaxDirectiveComponents';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const EMPLOYEES = [
  { id: 'e-1', employeeNumber: 'E001', firstName: 'Wanda', lastName: 'Test', taxNumber: '0123456789', endDate: '2026-04-30' },
  { id: 'e-2', employeeNumber: 'E002', firstName: 'Sam', lastName: 'Other', taxNumber: null },
];

function serve(posted: unknown[]) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'POST') {
      posted.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ success: true, data: { id: 'd-1' } }), { status: 201 });
    }
    if (String(url).startsWith('/api/payroll/employees')) return ok(EMPLOYEES);
    return ok([]);
  });
}

const fill = (label: string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('CreateTaxDirectiveModal: employee picker', () => {
  it('lists the company\'s employees, leavers included, from the employees route', async () => {
    serve([]);
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={() => {}} />);
    const select = await screen.findByLabelText('Employee *') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect([...select.options].map(o => o.text)).toEqual(['Select an employee', 'Test, Wanda (E001)', 'Other, Sam (E002)']);
    expect(select.required).toBe(true);
    expect(vi.mocked(apiFetch).mock.calls.map(c => String(c[0]))).toContain('/api/payroll/employees?include=terminated');
  });

  it('picking an employee pre-fills the name and tax number; the POST carries employee_id', async () => {
    const posted: unknown[] = [];
    serve(posted);
    const onCreated = vi.fn();
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={onCreated} />);
    const select = await screen.findByLabelText('Employee *') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: 'e-1' } });
    expect((screen.getByLabelText('Employee Name *') as HTMLInputElement).value).toBe('Wanda Test');
    expect((screen.getByLabelText('Tax Number') as HTMLInputElement).value).toBe('0123456789');
    fill('Gross Amount (ZAR) *', '10000');
    fill('Effective Date *', '2026-05-01');
    fireEvent.submit(select.closest('form')!);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted).toEqual([expect.objectContaining({
      employee_id: 'e-1', employee_name: 'Wanda Test', employee_tax_number: '0123456789', amount: 10_000,
    })]);
  });

  it('an employee with no tax number clears the one a previous pick filled', async () => {
    serve([]);
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={() => {}} />);
    const select = await screen.findByLabelText('Employee *') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: 'e-1' } });
    fireEvent.change(select, { target: { value: 'e-2' } });
    expect((screen.getByLabelText('Employee Name *') as HTMLInputElement).value).toBe('Sam Other');
    expect((screen.getByLabelText('Tax Number') as HTMLInputElement).value).toBe('');
  });

  it('a failed employee load says so in a plain sentence and blocks nothing else', async () => {
    route(url => (url.startsWith('/api/payroll/employees') ? empty500() : ok([])));
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('Could not load the employees - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
});
