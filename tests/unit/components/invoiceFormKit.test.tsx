/**
 * W2 PR I: the customer invoice new/edit forms on the kit (ContactPicker, Select, Input, DateField).
 * The POST/PUT bodies below were captured from the pre-kit forms (native selects and date inputs) and are asserted
 * verbatim: moving onto the kit must not change what the API receives. A refused or out-of-order date blocks submit.
 */
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { clickWhenEnabled, pickOption } from '../helpers/kitPick';
import { typeDate } from '../helpers/dateFields';

const push = vi.fn();
const scan = vi.hoisted(() => ({ current: { date: '2026-08-01', dueDate: '2026-08-31' } as { date: string | null; dueDate: string | null } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button onClick={() => onExtracted({ ...scan.current, vatRate: null, customerName: null, lineItems: [], confidence: 0.9 })}>scan stub</button>
  ),
}));
vi.mock('@/components/accounting/customer-invoices/InvoiceHeaderFields', async (orig) => {
  const m = await orig<typeof import('@/components/accounting/customer-invoices/InvoiceHeaderFields')>();
  return { ...m, InvoiceHeaderFields: vi.fn(m.InvoiceHeaderFields) };
});

import { InvoiceHeaderFields } from '@/components/accounting/customer-invoices/InvoiceHeaderFields';
import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(InvoiceHeaderFields).mockClear(); vi.mocked(apiFetch).mockReset(); });

const INV = { id: 'inv-1', invoice_number: 'INV-1', status: 'draft', client_id: 'c-1', invoice_date: '2026-09-15', due_date: '2026-10-15',
  billing_period_start: '2026-09-01', billing_period_end: '2026-09-30', tax_rate: 15, notes: 'old', currency_code: 'ZAR', exchange_rate: 1,
  items: [{ description: 'L', quantity: 1, unit_price: 10, amount: 10 }] };

function serve() {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('/customers')) return ok([{ id: 'c-1', name: 'Acme' }]);
    if (u.includes('currencies')) return ok([{ code: 'USD', name: 'US Dollar', symbol: '$' }]);
    if (u.includes('customer-invoices-create') && init?.method === 'POST') return ok({ id: 'n1' });
    if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return ok({});
    if (u.includes('customer-invoices-detail')) return ok(INV);
    return ok([]);
  });
}
const sentBody = (method: string): unknown => {
  const call = vi.mocked(apiFetch).mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === method);
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
};
const calls = (method: string) => vi.mocked(apiFetch).mock.calls.filter((c) => (c[1] as RequestInit | undefined)?.method === method).length;
const field = (label: string) => screen.getByLabelText(label === 'Invoice date' ? /^Invoice date/ : label); // Invoice date is required: its label also holds the asterisk
const submitNew = () => clickWhenEnabled(/^create invoice$/i);

async function fillNew() {
  render(<NewPage />);
  await pickOption('Client', 'Acme');
  await pickOption('Currency', /USD/);
  fireEvent.change(field('VAT rate %'), { target: { value: '14' } });
  fireEvent.change(field('Exchange rate (USD → ZAR)'), { target: { value: '18.5' } });
  typeDate(field('Invoice date'), '1 Oct 2026');
  typeDate(field('Due date'), '31 Oct 2026');
  typeDate(field('Period start'), '1 Sep 2026');
  typeDate(field('Period end'), '30 Sep 2026');
  fireEvent.change(field('Notes'), { target: { value: 'Thanks' } });
  fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Work' } });
  fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '50' } });
}

describe('request body is unchanged by the kit', () => {
  it('new invoice POST', async () => {
    serve();
    await fillNew();
    await submitNew();
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(sentBody('POST')).toEqual({
      clientId: 'c-1', invoiceDate: '2026-10-01', dueDate: '2026-10-31', billingPeriodStart: '2026-09-01', billingPeriodEnd: '2026-09-30',
      taxRate: 14, notes: 'Thanks', currencyCode: 'USD', exchangeRate: 18.5, projectId: '',
      items: [{ key: '1', description: 'Work', quantity: 1, unitPrice: 50, incomeType: 'other', discount: 0, glAccountId: '', projectId: '', cc2Id: '', buId: '' }],
    });
  });

  it('edit invoice PUT', async () => {
    serve();
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    typeDate(field('Invoice date'), '2 Oct 2026');
    typeDate(field('Due date'), '1 Nov 2026');
    fireEvent.change(field('Notes'), { target: { value: 'new notes' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(sentBody('PUT')).toEqual({
      id: 'inv-1', clientId: 'c-1', invoiceDate: '2026-10-02', dueDate: '2026-11-01', billingPeriodStart: '2026-09-01', billingPeriodEnd: '2026-09-30',
      taxRate: 15, notes: 'new notes', currencyCode: 'ZAR', exchangeRate: 1, projectId: null,
      items: [{ description: 'L', quantity: 1, unitPrice: 10, taxRate: 15, discount: 0, glAccountId: null, projectId: null, cc2Id: null, buId: null, cc1Id: null }],
    });
  });
});

describe('dates', () => {
  it('"1 Oct 2026" + blur puts 2026-10-01 in the POST body', async () => {
    serve();
    await fillNew();
    typeDate(field('Invoice date'), '1 Oct 2026');
    await submitNew();
    await waitFor(() => expect(calls('POST')).toBe(1));
    expect((sentBody('POST') as { invoiceDate: string }).invoiceDate).toBe('2026-10-01');
  });

  it('unreadable text in Due date blocks submit and says so on screen', async () => {
    serve();
    await fillNew();
    typeDate(field('Due date'), 'zz');
    await submitNew();
    expect((await screen.findAllByRole('alert')).map((a) => a.textContent).join('|')).toContain('Fix the dates marked in red before saving');
    expect(calls('POST')).toBe(0);
  });

  it('a due date before the invoice date is refused by the field and blocks submit', async () => {
    serve();
    await fillNew();
    typeDate(field('Due date'), '15 Sep 2026');
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join('|')).toContain('on or after 01 Oct 2026');
    await submitNew();
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join('|')).toContain('Fix the dates marked in red'));
    expect(calls('POST')).toBe(0);
  });

  it('moving the invoice date past an accepted due date blocks submit', async () => {
    serve();
    await fillNew();
    typeDate(field('Invoice date'), '15 Nov 2026');
    await submitNew();
    expect(await screen.findByText('The due date must be on or after the invoice date')).toBeTruthy();
    expect(calls('POST')).toBe(0);
  });

  it('a Due-date refusal made against the old invoice date is dropped when the invoice date moves', async () => {
    serve();
    await fillNew();
    typeDate(field('Due date'), '15 Sep 2026'); // refused: before the 1 Oct invoice date
    typeDate(field('Invoice date'), '1 Sep 2026');
    expect(screen.queryAllByRole('alert').map((a) => a.textContent).join('|')).not.toContain('on or after');
    await submitNew();
    await waitFor(() => expect(calls('POST')).toBe(1));
    expect((sentBody('POST') as { dueDate: string }).dueDate).toBe('2026-10-31'); // the last accepted due date
  });

  it('a scan fills the dates and discards refused text', async () => {
    serve();
    await fillNew();
    typeDate(field('Due date'), 'zz');
    fireEvent.click(screen.getByRole('button', { name: 'scan stub' }));
    await waitFor(() => expect((field('Due date') as HTMLInputElement).value).toBe('31 Aug 2026'));
    expect((field('Invoice date') as HTMLInputElement).value).toBe('01 Aug 2026');
    await submitNew();
    await waitFor(() => expect(calls('POST')).toBe(1));
    expect(sentBody('POST')).toMatchObject({ invoiceDate: '2026-08-01', dueDate: '2026-08-31' });
  });

  it('a scan with no due date drops refused Due-date text instead of leaving it red', async () => {
    serve();
    scan.current = { date: '2026-08-01', dueDate: null };
    render(<NewPage />);
    typeDate(field('Due date'), 'zz');
    fireEvent.click(screen.getByRole('button', { name: 'scan stub' }));
    await waitFor(() => expect((field('Invoice date') as HTMLInputElement).value).toBe('01 Aug 2026'));
    expect((field('Due date') as HTMLInputElement).value).toBe('');
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
    scan.current = { date: '2026-08-01', dueDate: '2026-08-31' };
  });

  it('Save & New clears the form, its due date and any refusal', async () => {
    serve();
    await fillNew();
    await clickWhenEnabled(/save & new/i);
    await waitFor(() => expect(calls('POST')).toBe(1));
    await waitFor(() => expect((field('Due date') as HTMLInputElement).value).toBe(''));
    expect((field('Invoice date') as HTMLInputElement).value).not.toBe('');
    expect(screen.queryAllByRole('alert')).toHaveLength(0);
  });

  it('a cleared invoice date blocks submit', async () => {
    serve();
    await fillNew();
    typeDate(field('Invoice date'), '');
    await submitNew();
    expect(await screen.findByText('Fix the dates marked in red before saving')).toBeTruthy(); // the page's refusal, shown after the click settled
    expect(calls('POST')).toBe(0);
  });

  it('a loaded invoice with no invoice date (empty, never refused) blocks save', async () => {
    serve();
    const base = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) =>
      String(url).includes('customer-invoices-detail') && !init?.method ? ok({ ...INV, invoice_date: null }) : base(url, init));
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await screen.findByText('Enter the invoice date');
    expect(calls('PUT')).toBe(0);
  });
});

describe('kit pickers', () => {
  it('ContactPicker selection sets clientId', async () => {
    serve();
    await fillNew();
    await submitNew();
    await waitFor(() => expect(calls('POST')).toBe(1));
    expect((sentBody('POST') as { clientId: string }).clientId).toBe('c-1');
  });

  it('submit without a client is refused', async () => {
    serve();
    render(<NewPage />);
    await submitNew();
    expect(await screen.findByText('Select a client')).toBeTruthy();
  });

  it('new and edit both render InvoiceHeaderFields', async () => {
    serve();
    render(<NewPage />);
    expect(vi.mocked(InvoiceHeaderFields)).toHaveBeenCalled();
    cleanup(); vi.mocked(InvoiceHeaderFields).mockClear();
    render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(vi.mocked(InvoiceHeaderFields)).toHaveBeenCalled();
  });

  it('the header controls are kit fields with no native date input (the Job picker and line selects stay native), and every control is named', async () => {
    serve();
    render(<NewPage />);
    expect(document.querySelectorAll('input[type="date"]').length).toBe(0);
    expect(screen.getByRole('combobox', { name: 'Client' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Currency' })).toBeTruthy();
    expect(screen.getByLabelText('Notes').tagName).toBe('TEXTAREA');
    expect(screen.getByLabelText('Income type').tagName).toBe('SELECT');
  });
});
