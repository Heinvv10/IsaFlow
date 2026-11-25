// "Received By" on the goods received list must name the person who received the goods.
// Defect: the new-GRN form posted its "Delivery note #" as receivedBy, and an empty one fell back to the raw user id.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import GoodsReceivedPage from '../../../pages/accounting/goods-received/index';
import NewGoodsReceivedPage from '../../../pages/accounting/goods-received/new';

const USER_ID = '3f2b8c1e-9d4a-4e7b-8a61-0c5d2e7f9a10';
afterEach(() => { vi.mocked(apiFetch).mockReset(); });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

describe('goods received list: Received By', () => {
  it('shows the receiver\'s name, never the raw user id', async () => {
    const row = { id: 'g1', grn_number: 'GRN-1', po_number: 'PO-1', supplier_name: 'Acme', received_date: '2026-01-01',
      received_by: USER_ID, received_by_name: 'Sam Receiver', notes: null, status: 'received', cancel_reason: null };
    vi.mocked(apiFetch).mockImplementation(async () => ok([row]));
    render(<GoodsReceivedPage />);
    await waitFor(() => expect(screen.getByText('GRN-1')).toBeTruthy());
    const tr = screen.getByText('GRN-1').closest('tr')!;
    expect(within(tr).getByText('Sam Receiver')).toBeTruthy();
    expect(tr.textContent).not.toContain(USER_ID);
  });
});

describe('new goods received note: Received By', () => {
  it('does not post the delivery note as receivedBy; it travels in the notes', async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      const u = String(url);
      const body = (init as { body?: string } | undefined)?.body;
      calls.push({ url: u, body: body ? JSON.parse(body) : null });
      if (u.includes('/purchase-orders?status=approved')) return ok([{ id: 'po1', po_number: 'PO-1', supplier_name: 'Acme' }]);
      if (u.includes('/purchase-orders?status=')) return ok([]);
      if (u.includes('/purchase-orders/po1')) return ok({ items: [{ id: 'pi1', description: 'Bolts', quantity: 5, quantity_received: 0 }] });
      return ok({ id: 'g1' });
    });
    render(<NewGoodsReceivedPage />);
    await waitFor(() => expect(screen.getByRole('option', { name: /PO-1/ })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Purchase order/), { target: { value: 'po1' } });
    await waitFor(() => expect(screen.getByText('Bolts')).toBeTruthy());
    fireEvent.change(screen.getByLabelText('Delivery note #'), { target: { value: 'DN-778' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create GRN$/ }));
    await waitFor(() => expect(calls.some((c) => c.body?.purchaseOrderId === 'po1')).toBe(true));
    const post = calls.find((c) => c.body?.purchaseOrderId === 'po1')!.body!;
    expect(post.receivedBy ?? null).toBeNull();
    expect(String(post.notes)).toContain('DN-778');
  });
});
