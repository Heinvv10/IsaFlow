/**
 * The supplier credit-note page's draft button used to post `cancel`, which refused every draft, and was labelled
 * Delete. A draft is now CANCELLED (no journal, number kept), so the button is "Cancel draft" and must post exactly
 * the DRAFT-ONLY action (`cancel_draft`, never `cancel`, which would reverse a posted note) for THIS note. Pins the
 * wire (endpoint, method, action, id), that the confirm gates it, and that the page leaves for the list only after
 * the server accepted.
 */
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';

const route = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'cn-1' }, push: route.push }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import SupplierCreditNoteDetailPage from '../../../pages/accounting/supplier-credit-notes/[id]';

const fetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;
const draft = {
  id: 'cn-1', creditNoteNumber: 'RTN0000001', type: 'supplier', supplierName: 'Acme Supplies', creditDate: '2026-09-01',
  subtotal: 100, taxRate: 15, taxAmount: 15, totalAmount: 115, status: 'draft', createdAt: '2026-09-01',
  approval: { state: 'not_required', enforced: false, requiredRole: 'owner', ruleName: null, requestId: null },
};
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const writes = () => fetchMock.mock.calls
  .filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')
  .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

beforeEach(() => {
  fetchMock.mockReset();
  route.push.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true));
  fetchMock.mockImplementation(async (_u: unknown, init?: RequestInit) => (init?.method === 'POST' ? ok({ ...draft, status: 'cancelled' }) : ok(draft)));
});

afterEach(() => { vi.unstubAllGlobals(); });

describe('supplier credit note page — Cancel draft', () => {
  it('offers Cancel draft (not Delete) on a draft', async () => {
    render(<SupplierCreditNoteDetailPage />);
    expect(await screen.findByRole('button', { name: /^Cancel draft$/ })).toBeDefined();
    expect(screen.queryByRole('button', { name: /^Delete$/ })).toBeNull();
  });

  it('clicking it posts cancel_draft (not cancel) for this note, then leaves for the list', async () => {
    render(<SupplierCreditNoteDetailPage />);
    const button = await screen.findByRole('button', { name: /^Cancel draft$/ });
    await act(async () => { fireEvent.click(button); });
    await waitFor(() => expect(writes()).toEqual([{
      url: '/api/accounting/credit-notes-action',
      body: { action: 'cancel_draft', creditNoteId: 'cn-1' },
    }]));
    expect(vi.mocked(globalThis.confirm)).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/supplier-credit-notes'));
  });

  it('declining the confirm sends nothing', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    render(<SupplierCreditNoteDetailPage />);
    const button = await screen.findByRole('button', { name: /^Cancel draft$/ });
    await act(async () => { fireEvent.click(button); });
    expect(writes()).toEqual([]);
    expect(route.push).not.toHaveBeenCalled();
  });

  it('a refusal shows the server message and keeps the page on the note', async () => {
    fetchMock.mockImplementation(async (_u: unknown, init?: RequestInit) => (init?.method === 'POST'
      ? new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: 'Credit note RTN0000001 has a pending approval request.' } }), { status: 400 })
      : ok(draft)));
    render(<SupplierCreditNoteDetailPage />);
    const button = await screen.findByRole('button', { name: /^Cancel draft$/ });
    await act(async () => { fireEvent.click(button); });
    expect(await screen.findByText(/pending approval request/)).toBeDefined();
    expect(route.push).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /^Cancel draft$/ })).toBeDefined();
  });
});
