/**
 * PR S round eleven, the edit page and WIP time-entry lines:
 * - a line that bills a time entry shows a "Time entry" badge; removing it asks first ("This unbills …"), and the
 *   removal is never autosaved: autosave holds, saying Save Changes saves it, and Approve & email refuses until then;
 * - a time-entry line is never dropped from the body: blanked, autosave and Save refuse it instead;
 * - an invoice billing time its lines do not link (grouped WIP, the timesheet path): removing a line says that time
 *   stays billed to the invoice.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, calls, DRAFT, puts, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import { invoicePutBody } from '@/components/accounting/customer-invoices/invoicePutBody';

useApiJsonOverMock();
let confirm: ReturnType<typeof vi.fn>;
const original = window.confirm;
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); confirm = vi.fn(() => true); window.confirm = confirm as unknown as typeof window.confirm; });
afterEach(() => { cleanup(); vi.useRealTimers(); window.confirm = original; vi.mocked(apiFetch).mockReset(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const statusText = () => screen.getAllByRole('status').map((e) => e.textContent).join(' | ');
const removeButtons = () => screen.getAllByRole('button', { name: 'Remove line' });
const WIP = {
  ...DRAFT, total_amount: 920,
  items: [
    { description: 'Time A', quantity: 2, unit_price: 300, amount: 600, time_entry_id: 'te-a' },
    { description: 'Travel', quantity: 1, unit_price: 200, amount: 200 },
  ],
};

async function open(invoice: object = WIP) {
  serveInvoice(undefined, invoice);
  render(<EditPage />);
  await settle();
}

describe('a line that bills a time entry', () => {
  it('shows a "Time entry" badge; the other lines do not', async () => {
    await open();
    expect(screen.getAllByText('Time entry')).toHaveLength(1);
  });

  it('removing it asks, naming its hours and description; Cancel keeps it', async () => {
    confirm.mockReturnValue(false);
    await open();
    fireEvent.click(removeButtons()[0]!);
    expect(confirm).toHaveBeenCalledWith(expect.stringMatching(/This unbills 2 h of time \("Time A"\); it can be billed again later/));
    expect(screen.getAllByPlaceholderText('Item description')).toHaveLength(2);
  });

  it('removed: autosave holds (Save Changes saves it), Approve & email refuses, Save Changes sends it', async () => {
    await open();
    fireEvent.click(removeButtons()[0]!);
    type(screen.getByLabelText('Notes'), 'Also a note');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    expect(statusText()).toMatch(/Not saved: .*Save Changes/);
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(calls('customer-invoices-detail', 'POST')).toHaveLength(0);
    expect(screen.getByText(/Save Changes first/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await settle();
    expect(puts()).toHaveLength(1);
    expect(bodyOf(puts()[0]!).items).toEqual([expect.objectContaining({ description: 'Travel', timeEntryId: null })]);
    type(screen.getByLabelText('Notes'), 'After the save');
    await advance(1_500);
    expect(puts()).toHaveLength(2); // saved: autosave runs again
  });

  it('removing a line without a time entry does not ask', async () => {
    await open();
    fireEvent.click(removeButtons()[1]!);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('blanked (no description, no price), it is not dropped from the body: autosave and Save refuse it', async () => {
    await open();
    type(screen.getAllByPlaceholderText('Item description')[0]!, '');
    type(screen.getAllByLabelText(/^Unit price/)[0]!, '0');
    await advance(5_000);
    expect(puts()).toHaveLength(0);
    expect(statusText()).toMatch(/Not saved: .*time-entry line/);
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
    await settle();
    expect(puts()).toHaveLength(0);
  });
});

describe('the body', () => {
  it('never drops a time-entry line, even blank (an unlinked blank line is left out quietly)', () => {
    const blank = { description: '', quantity: 1, unitPrice: 0, discount: 0, glAccountId: '', projectId: '', cc2Id: '', buId: '' };
    const body = invoicePutBody('inv-1', {
      form: { clientId: 'c-1', invoiceDate: '2026-09-15', dueDate: '', billingPeriodStart: '', billingPeriodEnd: '', taxRate: 15, notes: '', currencyCode: 'ZAR', exchangeRate: 1, projectId: '' },
      lines: [{ ...blank, key: 'a', timeEntryId: 'te-a' }, { ...blank, key: 'b' }],
      taxMode: 'exclusive',
    });
    expect(body.items.map((i) => i.timeEntryId)).toEqual(['te-a']);
  });
});

describe('an invoice billing time its lines do not link (grouped WIP, timesheet)', () => {
  it('removing a line says its time stays billed to the invoice', async () => {
    await open({ ...DRAFT, unlinked_time_entries: 3, items: [...DRAFT.items, { description: 'Grouped time', quantity: 5, unit_price: 100, amount: 500 }] });
    expect(screen.queryByText(/stays billed/)).toBeNull();
    fireEvent.click(removeButtons()[1]!);
    expect(confirm).not.toHaveBeenCalled();
    expect(screen.getByText(/3 time entries .* stays billed to this invoice/)).toBeTruthy();
  });

  it('an invoice billing no time: no such note', async () => {
    await open({ ...DRAFT, items: [...DRAFT.items, { description: 'Other', quantity: 1, unit_price: 50, amount: 50 }] });
    fireEvent.click(removeButtons()[1]!);
    expect(screen.queryByText(/stays billed/)).toBeNull();
  });
});
