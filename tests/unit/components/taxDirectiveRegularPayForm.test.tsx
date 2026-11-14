/**
 * Wave 5 DR: the new-directive form offers the IRP3(b) fixed-percentage and IRP3(c) fixed-amount types in the kit Select,
 * asks for a rate or a PAYE amount a month instead of a gross, and posts no gross for them (the server refuses one).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { CreateTaxDirectiveModal } from '@/components/payroll/TaxDirectiveComponents';
import { directiveAmountCell } from '@/components/payroll/taxDirectiveLabels';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const EMPLOYEES = [{ id: 'e-1', employeeNumber: 'E001', firstName: 'Wanda', lastName: 'Test', taxNumber: '0123456789' }];

function serve(posted: Array<Record<string, unknown>>) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if ((init?.method ?? 'GET').toUpperCase() === 'POST') {
      posted.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ success: true, data: { id: 'd-1' } }), { status: 201 });
    }
    return String(url).startsWith('/api/payroll/employees') ? ok(EMPLOYEES) : ok([]);
  });
}

const fill = (label: string | RegExp, value: string) => {
  const el = screen.getByLabelText(label);
  fireEvent.change(el, { target: { value } });
  fireEvent.blur(el);
};

async function openWith(type: string, posted: Array<Record<string, unknown>>, onCreated = vi.fn()) {
  serve(posted);
  render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={onCreated} />);
  const employee = await screen.findByLabelText('Employee *') as HTMLSelectElement;
  await waitFor(() => expect(employee.options.length).toBe(2));
  fireEvent.change(employee, { target: { value: 'e-1' } });
  fireEvent.click(screen.getByRole('combobox', { name: /Directive Type/ }));
  fireEvent.click(await within(await screen.findByRole('listbox')).findByRole('option', { name: type }));
  return employee.closest('form')!;
}

describe('CreateTaxDirectiveModal: regular-pay directives', () => {
  it('offers both new types beside the lump sums', async () => {
    serve([]);
    render(<CreateTaxDirectiveModal onClose={() => {}} onCreated={() => {}} />);
    fireEvent.click(screen.getByRole('combobox', { name: /Directive Type/ }));
    const names = within(await screen.findByRole('listbox')).getAllByRole('option').map(o => o.textContent);
    expect(names).toEqual(['Lump Sum', 'Retirement', 'Severance', 'Death', 'Fixed percentage (IRP3(b))', 'Fixed amount (IRP3(c))']);
  });

  it('fixed percentage: a required rate, no gross field; posts the fraction and no amount', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const onCreated = vi.fn();
    const form = await openWith('Fixed percentage (IRP3(b))', posted, onCreated);
    expect(screen.queryByLabelText('Gross Amount (ZAR) *')).toBeNull();
    expect((screen.getByLabelText('Directive Rate (%) *') as HTMLInputElement).required).toBe(true);
    fill('Directive Rate (%) *', '17.5');
    fill('Directive Number *', '1234567');
    fill(/^Effective Date/, '2026-03-01');
    fireEvent.submit(form);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted[0]).toEqual(expect.objectContaining({ directive_type: 'fixed_percentage', tax_rate: 0.175, employee_id: 'e-1', directive_number: '1234567' }));
    expect(posted[0]!.amount).toBeUndefined();
    expect(posted[0]!.tax_amount).toBeUndefined();
  });

  it('fixed amount: PAYE a month, no rate; posts tax_amount and no amount', async () => {
    const posted: Array<Record<string, unknown>> = [];
    const onCreated = vi.fn();
    const form = await openWith('Fixed amount (IRP3(c))', posted, onCreated);
    expect(screen.queryByLabelText(/Directive Rate/)).toBeNull();
    fill('PAYE a month (ZAR) *', '2500');
    fill('Directive Number *', '7654321');
    fill(/^Effective Date/, '2026-03-01');
    fireEvent.submit(form);
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(posted[0]).toEqual(expect.objectContaining({ directive_type: 'fixed_amount', tax_amount: 2500 }));
    expect(posted[0]!.amount).toBeUndefined();
    expect(posted[0]!.tax_rate).toBeUndefined();
  });

  it('the directive number is required for a regular-pay type (BRS code 3230), optional for a lump sum', async () => {
    await openWith('Fixed amount (IRP3(c))', []);
    expect((screen.getByLabelText('Directive Number *') as HTMLInputElement).required).toBe(true);
  });

  it('the list cell: R x PAYE a month for a fixed amount, a dash for a percentage, the gross for a lump sum', () => {
    expect(directiveAmountCell({ directiveType: 'fixed_amount', amount: 0, taxAmount: 2500 })).toMatch(/^R.2.500\.00 PAYE a month$/);
    expect(directiveAmountCell({ directiveType: 'fixed_percentage', amount: 0, taxAmount: null })).toBe('—');
    expect(directiveAmountCell({ directiveType: 'severance', amount: 10000, taxAmount: 1800 })).toMatch(/^R.10.000\.00$/);
  });
});
