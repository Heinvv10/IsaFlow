/**
 * Wave 2 PR A: the date gate on every form that carries `if (dates.blocked) return;`. For each page: fill the
 * form so it is otherwise ready, type a valid date, then refused text, then submit -> NO request. A control
 * (the refused text fixed -> the request goes out) proves the form was submittable, so removing the gate from
 * the page turns the "no request" assertion red instead of passing on some other early return.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: ({ onChange }: { onChange: (id: string, name: string) => void }) => (
    <button type="button" onClick={() => onChange('sup-1', 'Acme')}>pick-supplier</button>
  ),
}));

import { apiFetch } from '@/lib/apiFetch';
import BankTransfers from '../../../pages/accounting/bank-transfers/index';
import QuotesIndex from '../../../pages/accounting/customer-quotes/index';
import SalesOrdersIndex from '../../../pages/accounting/customer-sales-orders/index';
import DeliveryNoteNew from '../../../pages/accounting/delivery-notes/new';
import ExpenseNew from '../../../pages/accounting/expenses/new';
import GoodsReceivedNew from '../../../pages/accounting/goods-received/new';
import RecurringInvoiceNew from '../../../pages/accounting/recurring-invoices/new';
import RecurringJournals from '../../../pages/accounting/recurring-journals/index';
import SupplierCreditNoteNew from '../../../pages/accounting/supplier-credit-notes/new';
import SupplierPaymentNew from '../../../pages/accounting/supplier-payments/new';
import VatAdjustments from '../../../pages/accounting/vat-adjustments/index';

useApiJsonOverMock();
let respond: (url: string) => unknown = () => [];
beforeEach(() => {
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => ok(respond(String(url)) ?? []));
});
afterEach(cleanup);

const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
const box = (label: string): HTMLInputElement => screen.getByRole('textbox', { name: new RegExp(`^${label}`, 'i') }) as HTMLInputElement;
const click = async (name: RegExp): Promise<void> => { fireEvent.click(await screen.findByRole('button', { name })); };
const submitForm = (): void => { fireEvent.submit(document.querySelector('form')!); };
const change = (el: Element, value: string): void => { fireEvent.change(el, { target: { value } }); };
const byPlaceholder = (p: string): HTMLElement => screen.getByPlaceholderText(p);

interface GateCase {
  page: string;
  element: ReactElement;
  data?: (url: string) => unknown;
  /** Open a modal / form, then fill what the page needs besides the date. */
  ready: () => Promise<void> | void;
  field: string;
  /** The DateField is `required` (the native attribute it replaced would have stopped an empty submit). */
  required?: boolean;
  submit: () => Promise<void> | void;
}

const customers = [{ id: 'c1', name: 'Acme', company_name: 'Acme' }];

const cases: GateCase[] = [
  { page: 'bank-transfers', element: <BankTransfers />, field: 'Date',
    data: (u) => (u.includes('chart-of-accounts')
      ? [{ id: 'b1', accountCode: '1000', accountName: 'Cheque', accountSubtype: 'bank' }, { id: 'b2', accountCode: '1010', accountName: 'Savings', accountSubtype: 'bank' }]
      : undefined),
    ready: async () => {
      await screen.findAllByRole('option', { name: /1000/ });
      const [from, to] = screen.getAllByRole('combobox');
      change(from!, 'b1'); change(to!, 'b2'); change(byPlaceholder('0.00'), '50');
    },
    submit: () => click(/process transfer/i) },
  { page: 'customer-quotes (new quote)', element: <QuotesIndex />, field: 'Quote Date',
    data: (u) => (u.includes('/customers') ? customers : undefined),
    ready: async () => {
      await click(/new quote/i);
      await screen.findByRole('option', { name: 'Acme' });
      change(screen.getAllByRole('combobox')[0]!, 'c1');
      change(byPlaceholder('Item description'), 'Widget');
    },
    submit: () => { fireEvent.click(screen.getAllByRole('button', { name: /create quote/i }).at(-1)!); } },
  { page: 'customer-sales-orders (new order)', element: <SalesOrdersIndex />, field: 'Order Date',
    data: (u) => (u.includes('/customers') ? customers : undefined),
    ready: async () => {
      await click(/new (sales )?order/i);
      await screen.findByRole('option', { name: 'Acme' });
      change(screen.getAllByRole('combobox')[0]!, 'c1');
      change(await screen.findByPlaceholderText('Item description'), 'Widget');
    },
    submit: () => click(/create sales order/i) },
  { page: 'delivery-notes/new', required: true, element: <DeliveryNoteNew />, field: 'Delivery Date',
    data: (u) => (u.includes('/customers') ? customers : undefined),
    ready: async () => {
      await screen.findByRole('option', { name: 'Acme' });
      change(document.querySelector('select[name="customerId"]')!, 'c1');
      change(screen.getAllByRole('textbox', { name: '' }).find((i) => (i as HTMLInputElement).placeholder.toLowerCase().includes('description'))!, 'Widget');
    },
    submit: () => click(/save as draft/i) },
  { page: 'expenses/new', element: <ExpenseNew />, field: 'Claim date',
    data: (u) => (u.includes('/payroll/employees') ? [{ id: 'e1', first_name: 'Eve', last_name: 'Smith' }] : undefined),
    ready: async () => { await screen.findByRole('option', { name: /Eve Smith/ }); },
    submit: () => click(/create draft/i) },
  { page: 'goods-received/new', required: true, element: <GoodsReceivedNew />, field: 'Receipt Date',
    data: (u) => (u.includes('purchase-orders/po-1') ? { items: [{ id: 'i1', description: 'Bolts', quantity: 5, quantity_received: 0 }] }
      : u.includes('purchase-orders') ? [{ id: 'po-1', po_number: 'PO-1', supplier_name: 'Acme' }] : undefined),
    ready: async () => {
      await screen.findAllByRole('option', { name: /PO-1/ });
      change(document.querySelector('select[name="selectedPO"]')!, 'po-1');
      await screen.findByText('Bolts');
    },
    submit: () => click(/receive|submit|create|save/i) },
  { page: 'recurring-invoices/new', required: true, element: <RecurringInvoiceNew />, field: 'First Run Date',
    data: (u) => (u.includes('/customers') ? customers : undefined),
    ready: async () => {
      await screen.findByRole('option', { name: 'Acme' });
      change(document.querySelector('select[name="clientId"]')!, 'c1');
      change(byPlaceholder('Description *'), 'Retainer');
      change(screen.getAllByRole('spinbutton')[1]!, '100');
    },
    submit: submitForm },
  { page: 'recurring-journals', required: true, element: <RecurringJournals />, field: 'First Run Date',
    ready: async () => {
      await click(/new template/i);
      change(byPlaceholder('Template Name *'), 'Rent');
    },
    submit: submitForm },
  { page: 'supplier-credit-notes/new', required: true, element: <SupplierCreditNoteNew />, field: 'Credit Note Date',
    ready: async () => {
      fireEvent.click(screen.getByText('pick-supplier'));
      change(byPlaceholder('Item description'), 'Bolts');
      const [, price] = screen.getAllByRole('spinbutton');
      change(price!, '10');
    },
    submit: submitForm },
  { page: 'supplier-payments/new', required: true, element: <SupplierPaymentNew />, field: 'Payment Date',
    ready: () => { fireEvent.click(screen.getByText('pick-supplier')); },
    submit: submitForm },
  { page: 'vat-adjustments', required: true, element: <VatAdjustments />, field: 'Adjustment Date',
    ready: async () => { await click(/new adjustment/i); },
    submit: submitForm },
];

describe.each(cases)('$page', (c) => {
  const setUp = async (): Promise<void> => {
    respond = c.data ?? (() => undefined);
    render(c.element);
    await c.ready();
  };

  it('posts the valid date (the form is otherwise submittable)', async () => {
    await setUp();
    typeDate(box(c.field), '5 Oct 2031');
    await c.submit();
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
  });

  it('sends nothing while the date is refused, then sends once it is fixed', async () => {
    await setUp();
    typeDate(box(c.field), '5 Oct 2031');
    typeDate(box(c.field), 'zz');
    expect(box(c.field).getAttribute('aria-invalid')).toBe('true');
    await c.submit();
    await new Promise((r) => setTimeout(r, 30));
    expect(writes()).toHaveLength(0);
    typeDate(box(c.field), '6 Oct 2031');
    await c.submit();
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
  });
});

describe.each(cases.filter((c) => c.required))('$page: required date', (c) => {
  it('sends nothing once the date is cleared', async () => {
    respond = c.data ?? (() => undefined);
    render(c.element);
    await c.ready();
    typeDate(box(c.field), '5 Oct 2031');
    typeDate(box(c.field), '');
    expect(box(c.field).getAttribute('aria-invalid')).toBe('true');
    await c.submit();
    await new Promise((r) => setTimeout(r, 30));
    expect(writes()).toHaveLength(0);
  });
});
