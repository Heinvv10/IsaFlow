/**
 * The customer invoice page mounts the due-date editor for an open invoice with the stored source (payment-terms
 * programme, AR parity), and for no other status; a save reloads the invoice.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, calls, ok, routerEvents, serveInvoice } from '../helpers/invoiceAutosaveHarness';
import { typeDate } from '../helpers/dateFields';

const h = vi.hoisted(() => ({ events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));

import ViewPage from '../../../pages/accounting/customer-invoices/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const VIEW = (extra: object = {}) => ({
  id: 'inv-1', invoice_number: 'INV-1', client_name: 'Client', client_email: 'c@client.example', project_name: '', status: 'approved',
  invoice_date: '2026-09-01', due_date: '2026-10-01', due_date_source: 'manual', subtotal: 100, tax_rate: 0, tax_amount: 0, total_amount: 100,
  amount_paid: 0, notes: '', gl_journal_entry_id: null, currency_code: 'ZAR', exchange_rate: 1,
  items: [{ id: 'l-1', description: 'Line', quantity: 1, unit_price: 100, amount: 100, tax_rate: 0 }], approval: null, ...extra,
});
const serve = (extra: object = {}) => serveInvoice((u, init) => {
  if (u.includes('customer-invoices-due-date')) return ok({ changed: true });
  if (u.includes('adjacent')) return ok({ prevId: null, nextId: null });
  return init?.method ? undefined : undefined;
}, VIEW(extra));

describe('the due-date editor on the customer invoice page', () => {
  it.each([['approved', true], ['sent', true], ['overdue', true], ['partially_paid', true], ['draft', false], ['pending_approval', false], ['paid', false], ['cancelled', false]])(
    'a %s invoice: editor shown = %s', async (status, shown) => {
      serve({ status });
      render(<ViewPage />);
      await settle();
      expect(screen.getByText('INV-1', { selector: 'h1' })).toBeTruthy();
      expect(Boolean(screen.queryByText('Change due date'))).toBe(shown);
    });

  it('shows the stored source beside the date, and saves to the invoice route then reloads the invoice', async () => {
    serve({ due_date_source: 'document' });
    render(<ViewPage />);
    await settle();
    expect(screen.getByText('(From the document)')).toBeTruthy();
    fireEvent.click(screen.getByText('Change due date'));
    await settle();
    typeDate(screen.getByLabelText('New due date'), '31 Oct 2026');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await settle();
    const put = calls('customer-invoices-due-date', 'PUT');
    expect(put).toHaveLength(1);
    expect(JSON.parse(String((put[0]![1] as RequestInit).body))).toEqual({ id: 'inv-1', dueDate: '2026-10-31' });
    expect(calls('customer-invoices-detail?id=inv-1', 'GET').length).toBeGreaterThanOrEqual(2); // loaded, then reloaded after the save
  });
});
