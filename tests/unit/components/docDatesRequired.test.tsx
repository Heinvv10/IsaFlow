/**
 * Wave 2 PR A, review round: what the native `required` / `min` attributes used to guarantee, now that the date
 * inputs are DateFields.
 *  - A required date that starts empty and is never touched never commits, so the field reports nothing; submit
 *    itself must refuse it (recurring journals, a recurring invoice or PO loaded without a date).
 *  - An End Date is only checked against the First Run Date when the End Date commits; moving the First Run Date
 *    past an existing End Date must still be refused at submit (recurring invoices new and edit).
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
const route = vi.hoisted(() => ({ query: {} as Record<string, string> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: route.query, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import PoDetail from '../../../pages/accounting/purchase-orders/[poId]';
import RecurringInvoiceEdit from '../../../pages/accounting/recurring-invoices/[id]';
import RecurringInvoiceNew from '../../../pages/accounting/recurring-invoices/new';
import RecurringJournals from '../../../pages/accounting/recurring-journals/index';

useApiJsonOverMock();
let respond: (url: string) => unknown = () => [];
beforeEach(() => {
  route.query = {};
  vi.mocked(apiFetch).mockReset();
  vi.mocked(apiFetch).mockImplementation(async (url: unknown) => ok(respond(String(url)) ?? []));
});
afterEach(cleanup);

const writes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method && init.method !== 'GET');
const box = (label: string): HTMLInputElement => screen.getByRole('textbox', { name: new RegExp(`^${label}`, 'i') }) as HTMLInputElement;
const change = (el: Element, value: string): void => { fireEvent.change(el, { target: { value } }); };
const submit = (): void => { fireEvent.submit(document.querySelector('form')!); };
const settle = (): Promise<void> => new Promise((r) => { setTimeout(r, 30); });

const customers = [{ id: 'c1', name: 'Acme', company_name: 'Acme' }];
const invoiceItem = (extra: Record<string, unknown>) => ({
  items: [{ id: 'ri-1', templateName: 'T', clientId: 'c1', frequency: 'monthly', lineItems: [{ description: 'Fee', quantity: 1, unitPrice: 10 }], ...extra }],
});

describe('recurring-journals: an untouched empty First Run Date', () => {
  it('is refused at submit with a message, and nothing is posted', async () => {
    render(<RecurringJournals />);
    fireEvent.click(await screen.findByRole('button', { name: /new template/i }));
    change(screen.getByPlaceholderText('Template Name *'), 'Rent');
    expect(box('First Run Date').value).toBe('');
    submit();
    await settle();
    expect(writes()).toHaveLength(0);
    expect(screen.getByText(/enter the first run date/i)).toBeTruthy();
  });

  it('posts once the date is typed', async () => {
    render(<RecurringJournals />);
    fireEvent.click(await screen.findByRole('button', { name: /new template/i }));
    change(screen.getByPlaceholderText('Template Name *'), 'Rent');
    typeDate(box('First Run Date'), '5 Oct 2031');
    submit();
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    expect(JSON.parse(String(writes()[0]![1]!.body)).nextRunDate).toBe('2031-10-05');
  });
});

describe('recurring-invoices/[id]: a template loaded without a next run date', () => {
  it('is refused at submit with a message, and nothing is saved', async () => {
    route.query = { id: 'ri-1' };
    respond = (u) => (u.endsWith('recurring-invoices') ? invoiceItem({ nextRunDate: null }) : undefined);
    render(<RecurringInvoiceEdit />);
    await screen.findByDisplayValue('Fee');
    expect(box('Next Run Date').value).toBe('');
    submit();
    await settle();
    expect(writes()).toHaveLength(0);
    expect(screen.getByText(/enter the next run date/i)).toBeTruthy();
  });
});

describe('purchase-orders/[poId]: an order loaded without an order date', () => {
  it('is refused at save with a message, and nothing is saved', async () => {
    route.query = { poId: 'po-1' };
    respond = (u) => (u.endsWith('purchase-orders/po-1')
      ? { id: 'po-1', po_number: 'PO-1', status: 'draft', supplier_id: 's1', order_date: null, expected_delivery_date: null, items: [] } : undefined);
    render(<PoDetail />);
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    expect((await screen.findByRole('textbox', { name: /^order date/i }) as HTMLInputElement).value).toBe('');
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await settle();
    expect(writes()).toHaveLength(0);
    expect(screen.getByText(/enter the order date/i)).toBeTruthy();
  });
});

const endBeforeStart = /end date cannot be before the (first|next) run date/i;

describe('recurring-invoices/new: End Date before the First Run Date', () => {
  const fill = async (): Promise<void> => {
    respond = (u) => (u.includes('/customers') ? customers : undefined);
    render(<RecurringInvoiceNew />);
    await screen.findByRole('option', { name: 'Acme' });
    change(document.querySelector('select[name="clientId"]')!, 'c1');
    change(screen.getByPlaceholderText('Description *'), 'Retainer');
    change(screen.getAllByRole('spinbutton')[1]!, '100');
  };

  it('refuses a First Run Date moved past an existing End Date', async () => {
    await fill();
    typeDate(box('First Run Date'), '1 Dec 2031');
    typeDate(box('End Date'), '1 Jan 2032');
    typeDate(box('First Run Date'), '1 Mar 2032');
    expect(box('End Date').getAttribute('aria-invalid')).not.toBe('true');
    submit();
    await settle();
    expect(writes()).toHaveLength(0);
    expect(screen.getByText(endBeforeStart)).toBeTruthy();
  });

  it('posts once the End Date is on or after the First Run Date', async () => {
    await fill();
    typeDate(box('First Run Date'), '1 Dec 2031');
    typeDate(box('End Date'), '1 Jan 2032');
    typeDate(box('First Run Date'), '1 Jan 2032');
    submit();
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
    const body = JSON.parse(String(writes()[0]![1]!.body)) as Record<string, unknown>;
    expect([body.nextRunDate, body.endDate]).toEqual(['2032-01-01', '2032-01-01']);
  });
});

describe('recurring-invoices/[id]: End Date before the Next Run Date', () => {
  const load = async (): Promise<void> => {
    route.query = { id: 'ri-1' };
    respond = (u) => (u.endsWith('recurring-invoices') ? invoiceItem({ nextRunDate: '2031-12-01', endDate: '2032-01-01' }) : undefined);
    render(<RecurringInvoiceEdit />);
    await screen.findByDisplayValue('Fee');
  };

  it('refuses a Next Run Date moved past the existing End Date', async () => {
    await load();
    typeDate(box('Next Run Date'), '1 Mar 2032');
    submit();
    await settle();
    expect(writes()).toHaveLength(0);
    expect(screen.getByText(endBeforeStart)).toBeTruthy();
  });

  it('saves when the dates are in order', async () => {
    await load();
    typeDate(box('Next Run Date'), '1 Jan 2032');
    submit();
    await waitFor(() => expect(writes().length).toBeGreaterThan(0));
  });
});
