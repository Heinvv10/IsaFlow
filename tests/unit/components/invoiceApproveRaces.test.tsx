/**
 * PR S blind review: the windows around Approve & email.
 * - /new: a refused approval leaves the created draft and goes to its edit page; while that navigation is pending, or if
 *   it fails, the form stays inert, so no second click creates a second invoice. A failed navigation says so.
 * - /new: a scan landing while Approve & email runs changes nothing.
 * - The approval's baseline is taken before the save: a change typed while the save is out is reported.
 * - The email form closes only once the invoice page is open; a navigation that fails keeps it, and says so.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, calls, description, ok, pick, puts, refused, routerEvents, serveInvoice, type } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ push: vi.fn(), query: {} as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: h.push, replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({
  ScanAndFillButton: ({ onExtracted }: { onExtracted: (d: unknown) => void }) => (
    <button type="button" onClick={() => onExtracted({ date: null, dueDate: null, vatRate: null, customerName: null, confidence: 0.9,
      lineItems: [{ description: 'Scanned over it', quantity: 1, unitPrice: 999 }] })}>scan stub</button>
  ),
}));

import NewPage from '../../../pages/accounting/customer-invoices/new';
import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); h.push.mockReset(); vi.mocked(apiFetch).mockReset(); sessionStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const button = (name: RegExp) => screen.getByRole('button', { name });
const creates = () => calls('customer-invoices-create');
const REFUSAL = 'Customer invoice INV-AUTO needs owner approval before it can be posted (rule: big).';

async function openNew() {
  h.query = {};
  render(<NewPage />);
  await advance(0);
  await pick('Client', /Client/);
  type(description(), 'Approved work');
  type(screen.getAllByLabelText(/^Unit price/)[0]!, '100');
}

describe('/new: a refused approval', () => {
  const refuse = () => serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST'
    ? refused(409, REFUSAL, { reason: 'APPROVAL_REQUIRED' }) : undefined));

  it('while the edit page is opening, the form stays inert: a second click creates nothing', async () => {
    refuse();
    h.push.mockImplementation(() => new Promise(() => undefined)); // the navigation never finishes
    await openNew();
    fireEvent.click(button(/approve & email/i));
    await settle();
    expect(h.push).toHaveBeenCalledWith('/accounting/customer-invoices/edit/inv-1');
    expect(button(/^create invoice$/i)).toBeDisabled();
    expect(button(/approve & email/i)).toBeDisabled();
    expect(description()).toBeDisabled();
    fireEvent.click(button(/^create invoice$/i));
    fireEvent.click(button(/approve & email/i));
    await settle();
    expect(creates()).toHaveLength(1);
  });

  it('if the edit page cannot be opened, it says so and stays inert', async () => {
    refuse();
    h.push.mockRejectedValue(new Error('chunk load failed'));
    await openNew();
    fireEvent.click(button(/approve & email/i));
    await settle();
    expect(screen.getAllByRole('alert').map((a) => a.textContent).join(' ')).toMatch(/was created as a draft.*open it from the invoice list/i);
    expect(button(/^create invoice$/i)).toBeDisabled();
    expect(creates()).toHaveLength(1);
  });
});

describe('/new: a scan while Approve & email runs', () => {
  it('changes nothing on the form', async () => {
    serveInvoice((u) => (u.includes('customer-invoices-create') ? new Promise<Response>(() => undefined) : undefined));
    await openNew();
    fireEvent.click(button(/approve & email/i));
    await settle();
    fireEvent.click(screen.getByText('scan stub'));
    await settle();
    expect(description().value).toBe('Approved work');
  });
});

describe('edit: the approval baseline', () => {
  it('is taken before the save: a change typed while the save is out is reported with the email form', async () => {
    let release: (r: Response) => void = () => undefined;
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'PUT'
      ? new Promise<Response>((r) => { release = r; }) : undefined));
    h.query = { invoiceId: 'inv-1' };
    render(<EditPage />);
    await settle();
    type(description(), 'Saved by the approval');
    fireEvent.click(button(/approve & email/i));
    await settle();
    expect(puts()).toHaveLength(1);
    type(description(), 'Typed while the save was out');
    release(ok({ updated: true }));
    await settle();
    expect(screen.getByRole('heading', { name: 'Email Invoice' })).toBeTruthy();
    expect(screen.getByText(/changed while it was being approved/)).toBeTruthy();
  });
});

describe('closing the email form', () => {
  it('waits for the invoice page: a navigation that fails keeps the form open and says so', async () => {
    serveInvoice();
    h.push.mockResolvedValue(false);
    await openNew();
    fireEvent.click(button(/approve & email/i));
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    await settle();
    expect(h.push).toHaveBeenCalledWith('/accounting/customer-invoices/inv-1');
    expect(screen.getByRole('heading', { name: 'Email Invoice' })).toBeTruthy();
    expect(screen.getByText(/Could not open the invoice/)).toBeTruthy();
  });
});
