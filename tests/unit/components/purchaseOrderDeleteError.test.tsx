/**
 * R-129: the PO detail page's Delete swallowed every refusal (the catch only
 * reset `deleting`), so a 400 "no longer a draft" or a 409 left the user
 * looking at a button that did nothing. The API's message must be shown.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import PurchaseOrderDetailPage from '@/../pages/accounting/purchase-orders/[poId]';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({children}: {children: React.ReactNode}) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: { poId: 'po-1' } as Record<string, string>, isReady: true, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));

const po = {
  id: 'po-1', po_number: 'PO-R129', supplier_id: 's1', supplier_name: 'Supplier', order_date: '2026-09-01',
  expected_delivery_date: null, status: 'draft', subtotal: 100, tax_amount: 15, total: 115, notes: null,
  reference: null, created_at: '2026-09-01T00:00:00Z', items: [],
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});

function deleteAnswers(res: Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const path = String(url);
    if (path.endsWith('/purchase-orders/po-1') && init?.method === 'DELETE') return res;
    if (path.endsWith('/purchase-orders/po-1')) return json({data: po});
    return json({data: []});
  });
}

beforeEach(() => {
  route.push.mockReset();
  vi.stubGlobal('confirm', vi.fn(() => true));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

it('shows the API refusal when the order is no longer a draft', async () => {
  const message = 'Only draft purchase orders can be deleted (this one is submitted)';
  deleteAnswers(json({success: false, error: {code: 'BAD_REQUEST', message}}, 400));
  render(<PurchaseOrderDetailPage />);
  fireEvent.click(await screen.findByRole('button', {name: /delete/i}));
  expect(await screen.findByText(message)).toBeInTheDocument();
  expect(route.push).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('button', {name: /delete/i})).not.toBeDisabled());
});

it('shows a generic message when the refusal has no JSON body', async () => {
  deleteAnswers(new Response('Bad gateway', {status: 502}));
  render(<PurchaseOrderDetailPage />);
  fireEvent.click(await screen.findByRole('button', {name: /delete/i}));
  expect(await screen.findByText('Could not delete the purchase order - try again')).toBeInTheDocument();
  expect(route.push).not.toHaveBeenCalled();
});

it('navigates back to the list when the delete succeeds', async () => {
  deleteAnswers(json({success: true, data: {deleted: true, id: 'po-1'}}));
  render(<PurchaseOrderDetailPage />);
  fireEvent.click(await screen.findByRole('button', {name: /delete/i}));
  await waitFor(() => expect(route.push).toHaveBeenCalledWith('/accounting/purchase-orders'));
});
