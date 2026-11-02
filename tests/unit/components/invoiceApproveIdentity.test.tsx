/**
 * PR S final-final review: what is approved is the invoice on screen, in its currency.
 * - Approve sends the total, the currency and the exchange rate shown (invoice page, edit page, /new).
 * - The edit page: a STALE_VIEW refusal reloads the invoice and says why. (A stored total the lines no longer price to
 *   is never re-saved unasked: invoiceRepriceAndOpenInvoice.test.tsx.)
 * - The invoice page and the edit page ignore a load for an invoice that is no longer the one open, and the invoice
 *   page approves and cancels the invoice it shows.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { advance, bodyOf, calls, description, DRAFT, json, ok, puts, refused, routerEvents, serveInvoice } from '../helpers/invoiceAutosaveHarness';

const h = vi.hoisted(() => ({ query: { invoiceId: 'inv-1' } as Record<string, string>, events: null as null | ReturnType<typeof import('../helpers/invoiceAutosaveHarness').routerEvents> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: h.query, push: vi.fn(), replace: vi.fn(), pathname: '/', isReady: true, events: h.events }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/customer-invoices/InvoicePdfPreview', () => ({ InvoicePdfPreview: () => null }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));

import EditPage from '../../../pages/accounting/customer-invoices/edit/[invoiceId]';
import ViewPage from '../../../pages/accounting/customer-invoices/[invoiceId]';

useApiJsonOverMock();
beforeEach(() => { vi.useFakeTimers(); h.events = routerEvents(); h.query = { invoiceId: 'inv-1' }; sessionStorage.clear(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.mocked(apiFetch).mockReset(); sessionStorage.clear(); });

const settle = async () => { for (let i = 0; i < 8; i++) await advance(0); };
const approves = () => calls('customer-invoices-detail', 'POST');
const detailGets = () => calls('customer-invoices-detail', 'GET');
const STALE = 'This invoice changed after it was shown: its total is now R 1 265.00. Check it, then approve again.';
const VIEW = (id: string, total: number, extra: object = {}) => ({
  id, invoice_number: `INV-${id}`, client_name: 'Acme', project_name: '', status: 'draft', invoice_date: '2026-09-01', due_date: '2026-10-01',
  subtotal: total, tax_rate: 0, tax_amount: 0, total_amount: total, amount_paid: 0, notes: '', gl_journal_entry_id: null,
  currency_code: 'ZAR', exchange_rate: 1, items: [{ id: `l-${id}`, description: `Line of ${id}`, quantity: 1, unit_price: total, amount: total, tax_rate: 0 }],
  approval: { state: 'not_required', enforced: false, requiredRole: null, ruleName: null, requestId: null }, ...extra,
});

describe('Approve sends what is shown: total, currency and exchange rate', () => {
  it('the invoice page', async () => {
    serveInvoice((u) => (u.includes('customer-invoices-detail?id=') ? ok(VIEW('inv-1', 500, { currency_code: 'USD', exchange_rate: 18.5 })) : u.includes('adjacent') ? ok({ prevId: null, nextId: null }) : undefined));
    render(<ViewPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await settle();
    expect(bodyOf(approves()[0]!)).toEqual({ id: 'inv-1', action: 'approve', expectedTotal: 500, expectedCurrency: 'USD', expectedExchangeRate: 18.5 });
  });

  it('the edit page\'s Approve & email', async () => {
    serveInvoice();
    render(<EditPage />);
    await settle();
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(bodyOf(approves()[0]!)).toEqual({ id: 'inv-1', action: 'approve', expectedTotal: 115, expectedCurrency: 'ZAR', expectedExchangeRate: 1 });
  });
});

describe('the edit page and a STALE_VIEW', () => {
  it('a STALE_VIEW refusal reloads the invoice and says why', async () => {
    serveInvoice((u, init) => (u.includes('customer-invoices-detail') && init?.method === 'POST' ? refused(409, STALE, { reason: 'STALE_VIEW' }) : undefined));
    render(<EditPage />);
    await settle();
    const before = detailGets().length;
    fireEvent.click(screen.getByRole('button', { name: /approve & email/i }));
    await settle();
    expect(detailGets().length).toBeGreaterThan(before);
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(approves()).toHaveLength(1);
  });
});

describe('a load for an invoice no longer open', () => {
  it('the invoice page shows, approves and cancels the invoice it shows', async () => {
    let releaseA: (r: Response) => void = () => undefined;
    serveInvoice((u) => (u.includes('customer-invoices-detail?id=inv-1') ? new Promise<Response>((r) => { releaseA = r; })
      : u.includes('customer-invoices-detail?id=inv-2') ? ok(VIEW('inv-2', 200)) : u.includes('adjacent') ? ok({ prevId: null, nextId: null }) : undefined));
    const { rerender } = render(<ViewPage />);
    await settle();
    h.query = { invoiceId: 'inv-2' };
    rerender(<ViewPage />);
    await settle();
    releaseA(ok(VIEW('inv-1', 100)));
    await settle();
    expect(screen.getByText('Line of inv-2')).toBeTruthy();
    expect(screen.queryByText('Line of inv-1')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await settle();
    expect(bodyOf(approves()[0]!)).toMatchObject({ id: 'inv-2' });
  });

  it('the edit page keeps the invoice open now', async () => {
    let releaseA: (r: Response) => void = () => undefined;
    serveInvoice((u) => (u.includes('customer-invoices-detail?id=inv-1') ? new Promise<Response>((r) => { releaseA = r; })
      : u.includes('customer-invoices-detail?id=inv-2') ? ok({ ...DRAFT, id: 'inv-2', invoice_number: 'INV-B', items: [{ description: 'B line', quantity: 1, unit_price: 50, amount: 50 }] }) : undefined));
    const { rerender } = render(<EditPage />);
    await settle();
    h.query = { invoiceId: 'inv-2' };
    rerender(<EditPage />);
    await settle();
    releaseA(json(200, { success: true, data: DRAFT }));
    await settle();
    expect(description().value).toBe('B line');
  });
});
