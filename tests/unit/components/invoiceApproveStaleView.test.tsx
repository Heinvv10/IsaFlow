/**
 * PR S final review (HIGH): an invoice is never approved at a total the approver did not see.
 * - The invoice page sends the total it shows with Approve; the server answers 409 STALE_VIEW (no write) when the
 *   stored total differs, and the page reloads and says the invoice changed.
 * - A save still out for an invoice (the edit page's last change, sent as it closed) is waited for, a bounded while,
 *   before the invoice page reads it: the page shows what was saved.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('next/router', () => ({ useRouter: () => ({ query: { invoiceId: 'inv-1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/sars/MarkVatDeclaredElsewhereButton', () => ({ MarkVatDeclaredElsewhereButton: () => null }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { trackInvoiceSave } from '@/lib/pendingInvoiceSaves';
import CustomerInvoiceDetailPage from '../../../pages/accounting/customer-invoices/[invoiceId]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const invoice = (total: number) => ({
  id: 'inv-1', invoice_number: 'INV-0001', client_name: 'Acme', project_name: '', status: 'draft',
  invoice_date: '2026-09-01', due_date: '2026-10-01', subtotal: total / 1.15, tax_rate: 15, tax_amount: total - total / 1.15,
  total_amount: total, amount_paid: 0, notes: '', gl_journal_entry_id: null, items: [{ id: 'l1', description: `Line at ${total}`, quantity: 1, unit_price: total, amount: total, tax_rate: 15 }],
  shown_digest: `digest-${total}`,
  approval: { state: 'not_required', enforced: false, requiredRole: null, ruleName: null, requestId: null },
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const STALE = 'This invoice changed after it was shown: its total is now R 1 265.00. Check it, then approve again.';
const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const gets = () => fetchMock.mock.calls.filter(([u, init]) => String(u).startsWith('/api/accounting/customer-invoices-detail') && !(init as RequestInit | undefined)?.method);

beforeEach(() => { vi.useFakeTimers(); fetchMock.mockReset(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

describe('Approve on the invoice page', () => {
  it('sends the total it shows; a 409 STALE_VIEW reloads the invoice and says it changed', async () => {
    let total = 1150;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        total = 1265; // another tab saved meanwhile
        return new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message: STALE, details: { reason: 'STALE_VIEW' } } }), { status: 409 });
      }
      if (String(url).startsWith('/api/accounting/customer-invoices-detail')) return ok(invoice(total));
      return ok({ prevId: null, nextId: null });
    });
    render(<CustomerInvoiceDetailPage />);
    await flush();
    await flush();
    fireEvent.click(screen.getByRole('button', { name: /^Approve$/ }));
    await flush();
    await flush();
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'POST')!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ id: 'inv-1', action: 'approve', expectedTotal: 1150, expectedCurrency: 'ZAR', expectedExchangeRate: 1, expectedContentDigest: 'digest-1150' });
    expect(screen.getByText(STALE)).toBeTruthy();
    expect(screen.getByText('Line at 1265')).toBeTruthy(); // reloaded: what is stored now
  });
});

describe('a save still out for the invoice', () => {
  it('is waited for before the invoice page reads it', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).startsWith('/api/accounting/customer-invoices-detail') ? ok(invoice(1150)) : ok({ prevId: null, nextId: null })));
    let land: () => void = () => undefined;
    trackInvoiceSave('inv-1', new Promise<void>((r) => { land = r; }));
    render(<CustomerInvoiceDetailPage />);
    await flush(1_000);
    expect(gets()).toHaveLength(0);
    land();
    await flush();
    await flush();
    expect(gets()).toHaveLength(1);
  });

  it('is waited for a bounded while only: a save that never answers does not hold the page', async () => {
    fetchMock.mockImplementation(async (url: string) => (String(url).startsWith('/api/accounting/customer-invoices-detail') ? ok(invoice(1150)) : ok({ prevId: null, nextId: null })));
    trackInvoiceSave('inv-1', new Promise<void>(() => undefined));
    render(<CustomerInvoiceDetailPage />);
    await flush(4_000);
    expect(gets()).toHaveLength(0);
    await flush(1_500);
    expect(gets()).toHaveLength(1);
  });
});

// M14: this suite does not provide the auth context or the comments route; the panel has its own tests (commentsPanel, commentsMounts).
vi.mock('@/components/accounting/comments/CommentsPanel', () => ({ CommentsPanel: () => null }));
