/**
 * PR S round eight, the invoice page's loads and answers across an in-place move from A to B, one guard per test:
 * - A's GET answering after B's (or failing) never replaces B; A's answer while B still loads keeps the spinner;
 * - A's neighbours (Prev / Next) answering late are not B's;
 * - an email send for A still out does not leave B's form "Sending…";
 * - a clipboard copy for A finishing after the move says nothing on B.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, ok, routerEvents, serveInvoice } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ query: { invoiceId: 'inv-1' } as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));

import ViewPage from '../../../pages/accounting/customer-invoices/[invoiceId]';

useApiJsonOverMock();
let clipboard: (() => void) | null = null;
beforeEach(() => {
  vi.useFakeTimers(); h.events = routerEvents(); h.query = { invoiceId: 'inv-1' }; clipboard = null;
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: vi.fn(() => new Promise<void>((r) => { clipboard = r; })) }, configurable: true });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const VIEW = (id: string, extra: object = {}) => ({
  id, invoice_number: `INV-${id}`, client_name: `Client ${id}`, client_email: `${id}@client.example`, project_name: '', status: 'approved',
  invoice_date: '2026-09-01', due_date: '2026-10-01', subtotal: 100, tax_rate: 0, tax_amount: 0, total_amount: 100, amount_paid: 0, notes: '',
  gl_journal_entry_id: null, currency_code: 'ZAR', exchange_rate: 1, items: [{ id: `l-${id}`, description: `Line of ${id}`, quantity: 1, unit_price: 100, amount: 100, tax_rate: 0 }],
  approval: null, online_payment_enabled: true, payment_url: `https://pay.example/${id}`, ...extra,
});
type Pending = { a?: (r: Response) => void; aFail?: (e: Error) => void; b?: (r: Response) => void };
function serveGets(p: Pending, holdB = false) {
  serveInvoice((u) => {
    if (u.includes('customer-invoices-detail?id=inv-1')) return new Promise<Response>((res, rej) => { p.a = res; p.aFail = rej; });
    if (u.includes('customer-invoices-detail?id=inv-2')) return holdB ? new Promise<Response>((res) => { p.b = res; }) : ok(VIEW('inv-2'));
    if (u.includes('adjacent')) return ok({ prevId: null, nextId: null });
    return undefined;
  });
}
const toB = async (rerender: (ui: React.ReactElement) => void) => { h.query = { invoiceId: 'inv-2' }; rerender(<ViewPage />); await settle(); };

describe('A\'s GET across the move to B', () => {
  it('answering after B\'s: B stays', async () => {
    const p: Pending = {};
    serveGets(p);
    const { rerender } = render(<ViewPage />);
    await settle();
    await toB(rerender);
    expect(screen.getByText('Line of inv-2')).toBeTruthy();
    p.a!(ok(VIEW('inv-1')));
    await settle();
    expect(screen.getByText('Line of inv-2')).toBeTruthy();
    expect(screen.queryByText('Line of inv-1')).toBeNull();
  });

  it('failing after B\'s: B stays, and no error', async () => {
    const p: Pending = {};
    serveGets(p);
    const { rerender } = render(<ViewPage />);
    await settle();
    await toB(rerender);
    p.aFail!(new TypeError('Failed to fetch'));
    await settle();
    expect(screen.getByText('Line of inv-2')).toBeTruthy();
    expect(screen.queryByText(/Could not load the invoice/)).toBeNull();
  });

  it('answering while B still loads: the page keeps loading, it does not say "not found"', async () => {
    const p: Pending = {};
    serveGets(p, true);
    const { rerender } = render(<ViewPage />);
    await settle();
    await toB(rerender);
    p.a!(ok(VIEW('inv-1')));
    await settle();
    expect(screen.queryByText('Invoice not found')).toBeNull();
    p.b!(ok(VIEW('inv-2')));
    await settle();
    expect(screen.getByText('Line of inv-2')).toBeTruthy();
  });
});

describe('late answers for A on B\'s page', () => {
  it('A\'s neighbours answering late are not B\'s', async () => {
    let adjA: (r: Response) => void = () => undefined;
    serveInvoice((u) => {
      if (u.includes('adjacent?id=inv-1')) return new Promise<Response>((r) => { adjA = r; });
      if (u.includes('adjacent?id=inv-2')) return ok({ prevId: null, nextId: null });
      if (u.includes('customer-invoices-detail?id=inv-1')) return ok(VIEW('inv-1'));
      if (u.includes('customer-invoices-detail?id=inv-2')) return ok(VIEW('inv-2'));
      return undefined;
    });
    const { rerender } = render(<ViewPage />);
    await settle();
    await toB(rerender);
    adjA(ok({ prevId: 'inv-0', nextId: 'inv-9' }));
    await settle();
    expect((screen.getByTitle('Previous invoice') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle('Next invoice') as HTMLButtonElement).disabled).toBe(true);
  });

  it('A\'s neighbours, already shown, are not offered on B while B\'s are still out', async () => {
    serveInvoice((u) => {
      if (u.includes('adjacent?id=inv-1')) return ok({ prevId: 'inv-0', nextId: 'inv-9' });
      if (u.includes('adjacent?id=inv-2')) return new Promise<Response>(() => undefined);
      if (u.includes('customer-invoices-detail?id=inv-1')) return ok(VIEW('inv-1'));
      if (u.includes('customer-invoices-detail?id=inv-2')) return ok(VIEW('inv-2'));
      return undefined;
    });
    const { rerender } = render(<ViewPage />);
    await settle();
    expect((screen.getByTitle('Next invoice') as HTMLButtonElement).disabled).toBe(false); // A's were shown
    await toB(rerender);
    expect((screen.getByTitle('Previous invoice') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTitle('Next invoice') as HTMLButtonElement).disabled).toBe(true);
  });

  it('an email send for A still out does not leave B\'s form "Sending…"', async () => {
    serveInvoice((u) => {
      if (u.includes('invoice-email')) return new Promise<Response>(() => undefined);
      if (u.includes('customer-invoices-detail?id=inv-1')) return ok(VIEW('inv-1'));
      if (u.includes('customer-invoices-detail?id=inv-2')) return ok(VIEW('inv-2'));
      if (u.includes('adjacent')) return ok({ prevId: null, nextId: null });
      return undefined;
    });
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: 'Email Invoice' }));
    fireEvent.click(within(screen.getByRole('dialog', { name: 'Email Invoice' })).getByRole('button', { name: /send email/i }));
    await settle();
    await toB(rerender);
    fireEvent.click(screen.getByRole('button', { name: 'Email Invoice' }));
    expect(within(screen.getByRole('dialog', { name: 'Email Invoice' })).getByRole('button', { name: /send email/i })).not.toBeDisabled();
  });

  it.each([['Copy Payment Link', /Copied!/], ['Copy Portal Link', /Link Copied!/]])('%s for A finishing after the move says nothing on B', async (label, done) => {
    serveInvoice((u) => {
      if (u.includes('/api/portal/invoice/generate')) return ok({ portalUrl: 'https://portal.example/a' });
      if (u.includes('customer-invoices-detail?id=inv-1')) return ok(VIEW('inv-1'));
      if (u.includes('customer-invoices-detail?id=inv-2')) return ok(VIEW('inv-2'));
      if (u.includes('adjacent')) return ok({ prevId: null, nextId: null });
      return undefined;
    });
    const { rerender } = render(<ViewPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: label }));
    await settle();
    expect(clipboard).not.toBeNull();
    await toB(rerender);
    clipboard!();
    await settle();
    expect(screen.queryByRole('button', { name: done })).toBeNull();
  });
});

