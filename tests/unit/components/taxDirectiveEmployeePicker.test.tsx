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
    // The name is the employee record's (the server stores that one whatever is sent): shown, not typed.
    expect((screen.getByLabelText('Employee Name *') as HTMLInputElement).readOnly).toBe(true);
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

  it('while the employees load: says so, and Create is disabled', async () => {
    let release: (r: Response) => void = () => {};
    vi.mocked(apiFetch).mockImplementation(() => new Promise<Response>(r => { release = r; }));
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('Loading employees...')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Create Directive/ }) as HTMLButtonElement).disabled).toBe(true);
    release(ok(EMPLOYEES));
    await waitFor(() => expect((screen.getByRole('button', { name: /Create Directive/ }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('no employees: says how to fix it, and Create is disabled', async () => {
    vi.mocked(apiFetch).mockImplementation(async () => ok([]));
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('No payroll employees yet - add the employee under Payroll > Employees first')).toBeTruthy();
    expect((screen.getByRole('button', { name: /Create Directive/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a failed load: the error, no stale list, and Create is disabled', async () => {
    route(url => (url.startsWith('/api/payroll/employees') ? empty500() : ok([])));
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('Could not load the employees - try again')).toBeTruthy();
    expect((screen.getByLabelText('Employee *') as HTMLSelectElement).options.length).toBe(1);
    expect((screen.getByRole('button', { name: /Create Directive/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('a submit with no employee picked (the browser\'s required check bypassed) POSTs nothing and says why', async () => {
    const posted: unknown[] = [];
    serve(posted);
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={() => {}} />);
    const select = await screen.findByLabelText('Employee *') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.submit(select.closest('form')!);
    expect(await screen.findByText('Choose the employee the directive is paid to')).toBeTruthy();
    expect(posted).toEqual([]);
  });

  it('picking an employee with no tax number after one with a number: the POST carries no tax number (confirmation 1)', async () => {
    const posted: Array<Record<string, unknown>> = [];
    serve(posted as unknown[]);
    const onCreated = vi.fn();
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={onCreated} />);
    const select = await screen.findByLabelText('Employee *') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    fireEvent.change(select, { target: { value: 'e-1' } });
    fireEvent.change(select, { target: { value: 'e-2' } });
    fill('Gross Amount (ZAR) *', '10000');
    fill('Effective Date *', '2026-05-01');
    fireEvent.submit(select.closest('form')!);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted).toHaveLength(1);
    expect(posted[0]!.employee_id).toBe('e-2');
    expect(posted[0]!.employee_tax_number ?? '').toBe('');
  });

  it('a failed load offers Try again, which loads the list (confirmation 9)', async () => {
    let calls = 0;
    vi.mocked(apiFetch).mockImplementation(async (url) => {
      if (!String(url).startsWith('/api/payroll/employees')) return ok([]);
      calls += 1;
      return calls === 1 ? empty500() : ok(EMPLOYEES);
    });
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText('Could not load the employees - try again')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    const select = await screen.findByLabelText('Employee *') as HTMLSelectElement;
    await waitFor(() => expect(select.options.length).toBe(3));
    expect(screen.queryByText('Could not load the employees - try again')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
    expect(calls).toBe(2);
  });
});
