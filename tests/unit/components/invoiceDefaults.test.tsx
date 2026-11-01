/**
 * Master plan wave 3, PR D: the new-invoice page takes its due date, line discount and VAT mode from the customer,
 * and never over what the user typed. The tax-mode choice reaches the request body as a rate and ex-VAT prices.
 * "+30" counts from the invoice date, not from today.
 */
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { pickOption } from '../helpers/kitPick';
import { typeDate } from '../helpers/dateFields';

const push = vi.fn();
const scan = vi.hoisted(() => ({ current: { dueDate: null as string | null, vatRate: null as number | null, lineItems: [] as unknown[] } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push, replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button onClick={() => onExtracted({ date: null, customerName: null, confidence: 0.9, ...scan.current })}>scan stub</button>
  ),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(apiFetch).mockReset(); scan.current = { dueDate: null, vatRate: null, lineItems: [] }; });

interface Contact { payment_terms?: number | null; payment_terms_type?: string | null; default_discount?: string | number | null; default_vat_type?: string | null }
const ACME: Contact = { payment_terms: 30, payment_terms_type: 'days', default_discount: '10.00', default_vat_type: 'standard' };
const ZERO: Contact = { payment_terms: null, payment_terms_type: 'days', default_discount: '0.00', default_vat_type: 'zero' };
const BARE: Contact = { payment_terms: null, payment_terms_type: 'days', default_discount: '0.00', default_vat_type: null };
const INV = { id: 'inv-1', invoice_number: 'INV-1', status: 'draft', client_id: 'c-acme', invoice_date: '2026-09-15', due_date: '2026-10-15',
  tax_rate: 15, notes: '', currency_code: 'ZAR', exchange_rate: 1, items: [{ description: 'L', quantity: 1, unit_price: 115, amount: 115 }] };

function serve(contacts: Record<string, Contact> = { 'c-acme': ACME, 'c-zero': ZERO, 'c-bare': BARE }) {
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    const u = String(url);
    const id = /customers\?id=([^&]+)/.exec(u)?.[1];
    if (id) return ok({ id, name: id, ...contacts[id] });
    if (u.includes('/customers')) return ok(Object.keys(contacts).map((c) => ({ id: c, name: c })));
    if (u.includes('customer-invoices-create') && init?.method === 'POST') return ok({ id: 'n1' });
    if (u.includes('customer-invoices-detail') && init?.method === 'PUT') return ok({});
    if (u.includes('customer-invoices-detail')) return ok(INV);
    return ok([]);
  });
}
type Sent = { taxRate: number; dueDate: string; items: { unitPrice: number; discount: number; taxRate?: number }[] };
const sentBody = (method: string): Sent => {
  const call = vi.mocked(apiFetch).mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === method);
  return JSON.parse(String((call![1] as RequestInit).body)) as Sent;
};
const contactCalls = () => vi.mocked(apiFetch).mock.calls.filter((c) => String(c[0]).includes('customers?id='));

const invoiceDate = () => screen.getByLabelText(/^Invoice date/);
const due = () => screen.getByLabelText('Due date') as HTMLInputElement;
const describe0 = (i = 0) => screen.getAllByPlaceholderText('Item description')[i]!;
const price = (i = 0) => screen.getAllByLabelText('Unit price')[i]!;
const qty = (i = 0) => screen.getAllByLabelText('Quantity')[i]!;
const discounts = () => (screen.getAllByLabelText('Discount %') as HTMLInputElement[]).map((d) => d.value);
const pickClient = (name: string) => pickOption('Client', name);
const pickMode = (name: RegExp) => pickOption('Amounts are', name);
const hintFromCustomer = () => screen.queryAllByText(/from customer/i);
const submit = async () => {
  fireEvent.click(screen.getByRole('button', { name: /^create invoice$/i }));
  await waitFor(() => expect(push).toHaveBeenCalled());
};
const fillLine = (i = 0, gross = '115', quantity?: string) => {
  fireEvent.change(describe0(i), { target: { value: 'Work' } });
  fireEvent.change(price(i), { target: { value: gross } });
  if (quantity) fireEvent.change(qty(i), { target: { value: quantity } });
};
const open = async () => { render(<NewPage />); await screen.findByRole('combobox', { name: 'Client' }); typeDate(invoiceDate(), '1 Oct 2026'); };

describe('due date from the customer', () => {
  it('terms of 30 days set Due, with a hint', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    expect(screen.getByText(/from customer: 30 days/i)).toBeTruthy();
  });

  it('follows the invoice date until the user edits it', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    typeDate(invoiceDate(), '10 Oct 2026');
    await waitFor(() => expect(due().value).toBe('09 Nov 2026'));
  });

  it('a typed Due is not overwritten, by the invoice date or by another customer', async () => {
    serve();
    await open();
    typeDate(due(), '20 Oct 2026');
    await pickClient('c-acme');
    await waitFor(() => expect(contactCalls().length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    expect(due().value).toBe('20 Oct 2026');
    typeDate(invoiceDate(), '2 Oct 2026');
    await act(async () => { await Promise.resolve(); });
    expect(due().value).toBe('20 Oct 2026');
    expect(screen.queryByText(/from customer: 30 days/i)).toBeNull();
  });

  it('a Due the user cleared stays clear', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    typeDate(due(), '');
    typeDate(invoiceDate(), '2 Oct 2026');
    await act(async () => { await Promise.resolve(); });
    expect(due().value).toBe('');
  });

  it('a Due that came from a scan is not overwritten', async () => {
    serve();
    await open();
    scan.current = { ...scan.current, dueDate: '2026-12-25' };
    fireEvent.click(screen.getByText('scan stub'));
    await waitFor(() => expect(due().value).toBe('25 Dec 2026'));
    await pickClient('c-acme');
    await waitFor(() => expect(contactCalls().length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    expect(due().value).toBe('25 Dec 2026');
  });

  it('moving to a customer with no terms takes the default back out', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
    await pickClient('c-bare');
    await waitFor(() => expect(due().value).toBe(''));
    expect(hintFromCustomer()).toEqual([]);
  });

  it('an answer for the customer before the last one is dropped', async () => {
    const slow: { release?: () => void } = {};
    serve();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=c-acme')) await new Promise<void>((r) => { slow.release = r; });
      return inner(url, init);
    });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(slow.release).toBeTruthy());
    await pickClient('c-bare');
    await waitFor(() => expect(contactCalls().length).toBe(2));
    await act(async () => { slow.release!(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(due().value).toBe('');
  });

  it('when the customer cannot be read the page says so and the form still works', async () => {
    serve();
    const inner = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url, init) => {
      if (String(url).includes('customers?id=')) throw new TypeError('Failed to fetch');
      return inner(url, init);
    });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(screen.getAllByRole('alert').map((a) => a.textContent).join('|')).toMatch(/customer's terms/i));
    expect(due().value).toBe('');
  });
});

describe('"+30" in Due date', () => {
  it('counts from the invoice date, not from today', async () => {
    serve();
    await open();
    typeDate(due(), '+30');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
  });
});

describe('line discount from the customer', () => {
  it('lands on untouched lines only, and the column opens to show it', async () => {
    serve();
    await open();
    fillLine(0, '50');
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['', '10']));
    expect(screen.getByText(/10% discount from customer/i)).toBeTruthy();
    fillLine(1, '100');
    await submit();
    expect(sentBody('POST').items.map((i) => i.discount)).toEqual([0, 10]);
  });

  it('a line added after the customer starts on the discount', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    expect(discounts()).toEqual(['10', '10']);
  });

  it('a discount the user typed on an empty line is kept when the customer changes', async () => {
    serve({ 'c-acme': ACME, 'c-other': { ...ACME, default_discount: '5.00' } });
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    fireEvent.change(screen.getByLabelText('Discount %'), { target: { value: '7' } });
    await pickClient('c-other');
    await waitFor(() => expect(contactCalls().length).toBe(2));
    await act(async () => { await Promise.resolve(); });
    expect(discounts()).toEqual(['7']);
  });

  it('clearing a discount to retype it keeps the field', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    fireEvent.change(screen.getByLabelText('Discount %'), { target: { value: '' } });
    expect(discounts()).toEqual(['']);
  });

  it('moving to a customer with no discount takes the default back off an untouched line', async () => {
    serve();
    await open();
    await pickClient('c-acme');
    await waitFor(() => expect(discounts()).toEqual(['10']));
    await pickClient('c-bare');
    await waitFor(() => expect(screen.queryByLabelText('Discount %')).toBeNull());
  });

  it('a default that is out of range is held to what the server accepts', async () => {
    serve({ 'c-big': { ...ACME, default_discount: '120.00' } });
    await open();
    await pickClient('c-big');
    await waitFor(() => expect(discounts()).toEqual(['100']));
  });
});

describe('VAT mode', () => {
  it('a zero-rated customer pre-selects No VAT, with a hint, and posts taxRate 0', async () => {
    serve();
    await open();
    await pickClient('c-zero');
    await waitFor(() => expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).disabled).toBe(true));
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('0');
    expect(screen.getByText(/from customer: zero-rated/i)).toBeTruthy();
    fillLine();
    await submit();
    const body = sentBody('POST');
    expect(body.taxRate).toBe(0);
    expect(body.items[0]!.unitPrice).toBe(115);
  });

  it('a VAT mode the user chose is not overwritten by the customer', async () => {
    serve();
    await open();
    await pickMode(/Including VAT/);
    await pickClient('c-zero');
    await waitFor(() => expect(contactCalls().length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByText(/zero-rated/i)).toBeNull();
  });

  it('a rate the user typed is not overwritten by the customer', async () => {
    serve();
    await open();
    fireEvent.change(screen.getByLabelText('VAT rate %'), { target: { value: '14' } });
    await pickClient('c-zero');
    await waitFor(() => expect(contactCalls().length).toBe(1));
    await act(async () => { await Promise.resolve(); });
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('14');
  });

  it('leaving No VAT brings the rate back', async () => {
    serve();
    await open();
    await pickMode(/No VAT/);
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('0');
    await pickMode(/Excluding VAT/);
    expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).value).toBe('15');
  });

  it('inclusive 115 posts unitPrice 100', async () => {
    serve();
    await open();
    await pickClient('c-bare');
    await pickMode(/Including VAT/);
    fillLine();
    await submit();
    const body = sentBody('POST');
    expect(body.items[0]!.unitPrice).toBe(100);
    expect(body.taxRate).toBe(15);
  });

  it('the summary says when the stored total differs from the typed one', async () => {
    serve();
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '10', '3');
    const note = await screen.findByText(/you typed/i);
    expect(note.textContent?.replace(/\s/g, ' ')).toMatch(/You typed R ?30\.00 incl\. VAT; the invoice total is R ?30\.02/);
  });

  it('no message when the two agree', async () => {
    serve();
    await open();
    await pickMode(/Including VAT/);
    fillLine(0, '115');
    expect(within(screen.getByText('Invoice Summary').closest('.rounded-2xl') as HTMLElement).getByText(/115\.00/)).toBeTruthy();
    expect(screen.queryByText(/you typed/i)).toBeNull();
  });

  it('a scan carrying a rate is exclusive, as its prices are', async () => {
    serve();
    await open();
    await pickClient('c-bare');
    await pickMode(/Including VAT/);
    scan.current = { ...scan.current, vatRate: 15, lineItems: [{ description: 'Scanned', quantity: 1, unitPrice: 200 }] };
    fireEvent.click(screen.getByText('scan stub'));
    await waitFor(() => expect((describe0() as HTMLInputElement).value).toBe('Scanned'));
    await submit();
    expect(sentBody('POST').items[0]!.unitPrice).toBe(200);
  });

  it('Save & New starts clean: the defaults and the choices do not carry over', async () => {
    serve();
    await open();
    await pickClient('c-zero');
    await waitFor(() => expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).disabled).toBe(true));
    fillLine();
    fireEvent.click(screen.getByRole('button', { name: /save & new/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    await waitFor(() => expect((screen.getByLabelText('VAT rate %') as HTMLInputElement).disabled).toBe(false));
    expect(hintFromCustomer()).toEqual([]);
    typeDate(invoiceDate(), '1 Oct 2026');
    await pickClient('c-acme');
    await waitFor(() => expect(due().value).toBe('31 Oct 2026'));
  });
});

describe('edit page', () => {
  const load = async () => { render(<EditPage />); await screen.findByDisplayValue('L'); };

  it('loads stored ex-VAT prices in exclusive mode, and saves them unconverted', async () => {
    serve();
    await load();
    expect(screen.getByRole('combobox', { name: 'Amounts are' }).textContent).toMatch(/Excluding VAT/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = sentBody('PUT');
    expect(body.items[0]!.unitPrice).toBe(115);
    expect(body.taxRate).toBe(15);
  });

  it('asks nothing of the customer on load: a stored invoice is not refilled', async () => {
    serve();
    await load();
    expect(contactCalls()).toEqual([]);
    expect(due().value).toBe('15 Oct 2026');
    expect(hintFromCustomer()).toEqual([]);
  });

  it('inclusive saves the ex-VAT price, and No VAT saves rate 0 on the header and the lines', async () => {
    serve();
    await load();
    await pickMode(/Including VAT/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    expect(sentBody('PUT').items[0]!.unitPrice).toBe(100);
    cleanup(); push.mockClear(); vi.mocked(apiFetch).mockClear();

    await load();
    await pickMode(/No VAT/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(push).toHaveBeenCalled());
    const body = sentBody('PUT');
    expect(body.taxRate).toBe(0);
    expect(body.items[0]!.taxRate).toBe(0);
    expect(body.items[0]!.unitPrice).toBe(115);
  });

  it('heads the page with PageHeader, not the always-dark banner', async () => {
    serve();
    const { container } = render(<EditPage />);
    await screen.findByDisplayValue('L');
    expect(screen.getByRole('heading', { level: 1, name: 'INV-1' })).toBeTruthy();
    expect(container.querySelector('.bg-gradient-to-br')).toBeNull();
    expect(screen.getByText('Edit draft')).toBeTruthy();
  });
});
