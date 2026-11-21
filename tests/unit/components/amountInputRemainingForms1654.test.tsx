/**
 * #1654: line-item money fields on quotes, sales orders, customer invoices and supplier bills keep what is typed.
 * Typing "5000" into a field showing 0 gives 5000 (not "05000"), clearing leaves it empty, and the number reaches the
 * submit payload / parent state.
 */
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2R3a4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string>, push: vi.fn(), isReady: true }));
vi.mock('next/router', () => ({ useRouter: () => route }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1' } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import CustomerQuotesPage from '../../../pages/accounting/customer-quotes/index';
import CustomerSalesOrdersPage from '../../../pages/accounting/customer-sales-orders/index';
import { InvoiceLineItemsTable, type InvoiceLine } from '@/components/accounting/customer-invoices/InvoiceLineItemsTable';
import { invoiceLineAmount } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { BillLineItemsTable, type BillLineItem } from '@/components/accounting/suppliers/BillLineItemsTable';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.push.mockReset(); });
afterEach(() => { cleanup(); });

const type = (el: HTMLElement, text: string) => {
  fireEvent.focus(el);
  let acc = '';
  for (const ch of text) { acc += ch; fireEvent.change(el, { target: { value: acc } }); }
};
const val = (label: string) => (screen.getByLabelText(label) as HTMLInputElement).value;

describe.each([
  { name: 'quote', create: /Create Quote/, open: /New Quote/, intro: 'Fill in the quote details below', url: 'customer-quotes', price: 'Unit price, line 1', qty: 'Quantity, line 1',
    list: { quotes: [], total: 0 } },
  { name: 'sales order', create: /Create Sales Order/, open: /New Sales Order/, intro: 'Fill in the order details below', url: 'customer-sales-orders', price: 'Unit price, line 1', qty: 'Quantity, line 1',
    list: { orders: [], total: 0 } },
])('$name create modal', ({ name, create, open, intro, url, price, qty, list }) => {
  const Page = url === 'customer-quotes' ? CustomerQuotesPage : CustomerSalesOrdersPage;
  const posted: string[] = [];
  const openModal = async () => {
    posted.length = 0;
    vi.mocked(apiFetch).mockImplementation(async (u, init) => {
      if (init?.method === 'POST') { posted.push(String(init.body)); return ok({ id: 'x' }); }
      if (String(u).includes('/customers')) return ok([{ id: 'c1', name: 'Cust' }]);
      return ok(list);
    });
    render(<Page />);
    fireEvent.click((await screen.findAllByRole('button', { name: open }))[0]!);
    await screen.findByText(intro);
    await screen.findByRole('option', { name: 'Cust' });
    fireEvent.change(screen.getAllByRole('combobox').find((s) => s.querySelector('option[value="c1"]'))!, { target: { value: 'c1' } });
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'Widget' } });
  };

  it('quantity decimals equal the column scale (quote numeric(10,2), order numeric(12,4)); a quote may be 0.5', async () => {
    await openModal();
    const ok = name === 'quote' ? '0.5' : '1.2345';
    const tooMany = name === 'quote' ? '0.555' : '1.23456';
    type(screen.getByLabelText(qty), ok);
    expect(val(qty)).toBe(ok);
    if (name === 'quote') expect(screen.getByLabelText(qty).getAttribute('aria-invalid')).toBeNull(); // server accepts > 0
    fireEvent.change(screen.getByLabelText(qty), { target: { value: tooMany } });
    expect(val(qty)).toBe(ok);
  });

  it('typing 5000 into the 0 unit price gives 5000, no leading zero', async () => {
    await openModal();
    type(screen.getByLabelText(price), '5000');
    expect(val(price)).toBe('5000');
  });

  it('clearing the unit price leaves it empty', async () => {
    await openModal();
    type(screen.getByLabelText(price), '5');
    fireEvent.change(screen.getByLabelText(price), { target: { value: '' } });
    expect(val(price)).toBe('');
  });

  it('a decimal quantity and price round-trip into the submitted body', async () => {
    await openModal();
    type(screen.getByLabelText(qty), '2.5');
    type(screen.getByLabelText(price), '5000.75');
    const btns = screen.getAllByRole('button', { name: create });
    fireEvent.click(btns[btns.length - 1]!);
    await waitFor(() => expect(posted.length).toBe(1));
    const body = JSON.parse(posted[0]!) as { lines?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>> };
    const line = (body.lines ?? body.items)![0]!;
    expect(Object.values(line)).toContain(2.5);
    expect(JSON.stringify(line)).toMatch(/5000\.75|500075/);
  });
});

const OPTIONS = { accounts: [], projects: [], cc2s: [], bus: [], known: {}, status: 'ready' as const, error: '', retry: () => {} };
let invStored: InvoiceLine[] = [];
function InvoiceHarness() {
  const [lines, setLines] = useState<InvoiceLine[]>([{ key: 'a', description: '', quantity: 1, unitPrice: 0, discount: 0, glAccountId: '', projectId: '', cc2Id: '', buId: '' }]);
  invStored = lines;
  return (
    <InvoiceLineItemsTable lines={lines} currencyCode="ZAR" lineTotal={(l) => invoiceLineAmount(l.quantity, l.unitPrice, l.discount)} options={OPTIONS as never}
      onUpdate={(key, field, v) => setLines((p) => p.map((l) => (l.key === key ? { ...l, [field]: v } : l)))} onAdd={() => {}} onRemove={() => {}} />
  );
}

describe('InvoiceLineItemsTable', () => {
  it('typing 5000 into the 0 unit price gives 5000 and stores 5000', () => {
    render(<InvoiceHarness />);
    type(screen.getByLabelText('Unit price'), '5000');
    expect(val('Unit price')).toBe('5000');
    expect(invStored[0]!.unitPrice).toBe(5000);
  });
  it('clearing the unit price leaves it empty and stores 0', () => {
    render(<InvoiceHarness />);
    type(screen.getByLabelText('Unit price'), '5');
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '' } });
    expect(val('Unit price')).toBe('');
    expect(invStored[0]!.unitPrice).toBe(0);
  });
  it('a partial "2325." is kept while typing and a decimal quantity stores', () => {
    render(<InvoiceHarness />);
    type(screen.getByLabelText('Unit price'), '2325.');
    expect(val('Unit price')).toBe('2325.');
    type(screen.getByLabelText('Quantity'), '1.5');
    expect(invStored[0]!.quantity).toBe(1.5);
  });
});

describe('InvoiceLineItemsTable decimals', () => {
  it('quantity (numeric(10,2)) and unit price (numeric(15,2)) take 2 decimals', () => {
    render(<InvoiceHarness />);
    type(screen.getByLabelText('Unit price'), '10.25');
    fireEvent.change(screen.getByLabelText('Unit price'), { target: { value: '10.255' } });
    expect(val('Unit price')).toBe('10.25');
    type(screen.getByLabelText('Quantity'), '1.25');
    fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '1.255' } });
    expect(val('Quantity')).toBe('1.25');
    expect(invStored[0]!.quantity * invStored[0]!.unitPrice).toBeCloseTo(12.8125, 4);
    expect(invoiceLineAmount(1.25, 10.25, 0)).toBe(12.81); // the table's total is rounded like this, so no hidden third decimal
  });
});

let billStored: BillLineItem[] = [];
function BillHarness() {
  const [lines, setLines] = useState<BillLineItem[]>([{ key: 'k', description: '', quantity: 1, unitPrice: 0, taxRate: 15, glAccountId: '' }]);
  billStored = lines;
  return (
    <BillLineItemsTable lines={lines} glAccounts={[]} onAdd={() => {}} onRemove={() => {}}
      onUpdate={(key, field, v) => setLines((p) => p.map((l) => (l.key === key ? { ...l, [field]: v } : l)))} />
  );
}

describe('BillLineItemsTable', () => {
  it('typing 5000 into the 0 unit price gives 5000 and stores 5000', () => {
    render(<BillHarness />);
    type(screen.getByLabelText('Line 1 unit price'), '5000');
    expect(val('Line 1 unit price')).toBe('5000');
    expect(billStored[0]!.unitPrice).toBe(5000);
  });
  it('clearing the unit price leaves it empty and stores 0', () => {
    render(<BillHarness />);
    type(screen.getByLabelText('Line 1 unit price'), '5');
    fireEvent.change(screen.getByLabelText('Line 1 unit price'), { target: { value: '' } });
    expect(val('Line 1 unit price')).toBe('');
    expect(billStored[0]!.unitPrice).toBe(0);
  });
  it('decimals equal the stored scale: price 2 (numeric(15,2)), quantity 4 (numeric(12,4))', () => {
    render(<BillHarness />);
    type(screen.getByLabelText('Line 1 unit price'), '12.34');
    expect(billStored[0]!.unitPrice).toBe(12.34);
    fireEvent.change(screen.getByLabelText('Line 1 unit price'), { target: { value: '12.345' } });
    expect(val('Line 1 unit price')).toBe('12.34');
    type(screen.getByLabelText('Line 1 quantity'), '1.2345');
    expect(billStored[0]!.quantity).toBe(1.2345);
    fireEvent.change(screen.getByLabelText('Line 1 quantity'), { target: { value: '1.23456' } });
    expect(val('Line 1 quantity')).toBe('1.2345');
  });
});
