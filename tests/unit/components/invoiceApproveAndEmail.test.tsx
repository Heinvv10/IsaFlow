/**
 * Master plan wave 3, PR S: "Approve & email" saves (create on the new page; the draft PUT on edit, only if something
 * changed), approves, and opens the email form with the customer's address. Sending stays the user's own click on the
 * existing /api/accounting/invoice-email: nothing here sends by itself. An approval refused (the gate's three 409s, a
 * 400, a lock-timeout 503) leaves the draft, lands on its edit page with the server's sentence, and is never retried.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, calls, description, pick, puts, refused, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ push: vi.fn(), query: {} as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: h.push, replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); h.push.mockReset(); vi.mocked(apiFetch).mockReset(); sessionStorage.clear(); });

const urlsInOrder = () => vi.mocked(apiFetch).mock.calls
  .map(([u, init]) => `${init?.method ?? 'GET'} ${String(u).split('?')[0]}`)
  .filter((c) => /create|customer-invoices-detail|invoice-email/.test(c) && c !== 'GET /api/accounting/customer-invoices-detail');
const approves = () => calls('customer-invoices-detail', 'POST');
const emails = () => calls('invoice-email');
const approveAndEmail = async () => {
  fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
  for (let i = 0; i < 6; i++) await advance(0);
};
// InvoiceEmailModal has no dialog role (S changes its props only): found by its heading.
const dialog = () => screen.queryByRole('heading', { name: 'Email Invoice' });

async function openNew() {
  h.query = {};
  render(<NewPage />);
  await advance(0);
  await pick('Client', /Client/);
  type(description(), 'Approved work');
  type(screen.getAllByLabelText(/^Unit price/)[0]!, '100');
}
async function openEdit() {
  h.query = { invoiceId: 'inv-1' };
  render(<EditPage />);
  await advance(0);
  await advance(0);
}

describe('Approve & email on a new invoice', () => {
  it('creates, approves, then opens the email form with the customer\'s address; nothing is sent until Send', async () => {
    serveInvoice();
    await openNew();
    await approveAndEmail();
    expect(urlsInOrder()).toEqual(['POST /api/accounting/customer-invoices-create', 'POST /api/accounting/customer-invoices-detail']);
    expect(bodyOf(approves()[0]!)).toEqual({ id: 'inv-1', action: 'approve' });
    expect(dialog()).toBeTruthy();
    expect((screen.getByPlaceholderText('client@example.com') as HTMLInputElement).value).toBe('billing@client.example');
    await advance(30_000);
    expect(emails()).toHaveLength(0);

    fireEvent.click(screen.getByRole('button', { name: /send email/i }));
    for (let i = 0; i < 4; i++) await advance(0);
    expect(emails()).toHaveLength(1);
    expect(bodyOf(emails()[0]!)).toEqual({ invoiceId: 'inv-1', recipientEmail: 'billing@client.example' });
  });

  it('once approved, the form behind the email form is inert: Enter or a click on Create makes no second invoice', async () => {
    serveInvoice();
    await openNew();
    await approveAndEmail();
    expect(dialog()).toBeTruthy();
    const create = screen.getByRole('button', { name: /^create invoice$/i });
    expect(create).toBeDisabled();
    expect(screen.getByRole('button', { name: /save & new/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /approve & email/i })).toBeDisabled();
    expect(description()).toBeDisabled();
    create.focus();
    fireEvent.keyDown(create, { key: 'Enter' });
    fireEvent.keyUp(create, { key: 'Enter' });
    fireEvent.click(create);
    fireEvent.submit(create);
    for (let i = 0; i < 6; i++) await advance(0);
    expect(calls('customer-invoices-create')).toHaveLength(1);
  });

  it('closing the email form lands on the invoice, approved and unsent', async () => {
    serveInvoice();
    await openNew();
    await approveAndEmail();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await advance(0);
    expect(h.push).toHaveBeenCalledWith('/accounting/customer-invoices/inv-1');
    expect(emails()).toHaveLength(0);
  });

  it('a create the server refuses approves nothing', async () => {
    serveInvoice((u) => (u.includes('customer-invoices-create') ? refused(400, 'Revenue account is not active') : undefined));
    await openNew();
    await approveAndEmail();
    expect(approves()).toHaveLength(0);
    expect(screen.getByText('Revenue account is not active')).toBeTruthy();
    expect(dialog()).toBeNull();
  });

  it('an approval refused after create lands on the draft\'s edit page, once, and the edit page shows why', async () => {
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST'
      ? refused(409, 'Customer invoice INV-AUTO needs owner approval before it can be posted (rule: big).', { reason: 'APPROVAL_REQUIRED' }) : undefined));
    await openNew();
    await approveAndEmail();
    await advance(30_000);
    expect(approves()).toHaveLength(1);
    expect(dialog()).toBeNull();
    expect(h.push).toHaveBeenCalledWith('/accounting/customer-invoices/edit/inv-1');
    cleanup();
    await openEdit();
    expect(screen.getByText(/needs owner approval before it can be posted/)).toBeTruthy();
  });
});

describe('Approve & email on the edit page', () => {
  it('an unchanged draft is approved without a PUT; a changed one is saved first, then approved', async () => {
    serveInvoice();
    await openEdit();
    await approveAndEmail();
    expect(puts()).toHaveLength(0);
    expect(urlsInOrder()).toEqual(['POST /api/accounting/customer-invoices-detail']);
    expect(dialog()).toBeTruthy();
    cleanup();
    vi.mocked(apiFetch).mockClear();

    await openEdit();
    type(description(), 'Changed before approval');
    await approveAndEmail();
    expect(urlsInOrder()).toEqual(['PUT /api/accounting/customer-invoices-detail', 'POST /api/accounting/customer-invoices-detail']);
    expect(bodyOf(puts()[0]!).items[0]!.description).toBe('Changed before approval');
    await advance(30_000);
    expect(puts()).toHaveLength(1); // autosave does not follow the approval with a PUT on an approved invoice
  });

  const REFUSALS: [string, number, string, string | undefined][] = [
    ['APPROVAL_REQUIRED', 409, 'Customer invoice INV-AUTO needs owner approval before it can be posted (rule: big).', 'APPROVAL_REQUIRED'],
    ['APPROVAL_PENDING', 409, 'Customer invoice INV-AUTO is awaiting approval by a owner before it can be posted (rule: big).', 'APPROVAL_PENDING'],
    ['APPROVAL_STALE', 409, 'Customer invoice INV-AUTO changed after it was approved; submit it for approval again (rule: big).', 'APPROVAL_STALE'],
    ['a journal-date 400', 400, 'The invoice date falls in a closed period', undefined],
    ['a lock-timeout 503', 503, 'Another change to this invoice is in progress - try again in a moment', undefined],
  ];
  it.each(REFUSALS)('%s leaves the draft, shows the server\'s sentence and is not retried', async (_name, status, message, reason) => {
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? refused(status, message, reason ? { reason } : undefined) : undefined));
    await openEdit();
    await approveAndEmail();
    await advance(60_000);
    expect(approves()).toHaveLength(1);
    expect(screen.getByText(message)).toBeTruthy();
    expect(dialog()).toBeNull();
    expect(emails()).toHaveLength(0);
    expect(h.push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /approve & email/i })).toBeTruthy();
  });
});
