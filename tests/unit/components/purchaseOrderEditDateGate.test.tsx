// The PO edit form's date gate has to end with the form. A refusal typed in an edit that was cancelled must not
// outlive it: Edit opened again shows the good date, so Save must work rather than say "fix the date marked in red".
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, on, serve, writeCalls } from '../helpers/d2R3a6';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
const route = vi.hoisted(() => ({ query: { poId: 'po-1' } as Record<string, string>, isReady: true, push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => route }));

import { apiFetch } from '@/lib/apiFetch';
import PurchaseOrderDetailPage from '../../../pages/accounting/purchase-orders/[poId]';

useApiJsonOverMock();
const po = {
  id: 'po-1', po_number: 'PO-1', supplier_id: 's1', supplier_name: 'Supplier', order_date: '2026-09-01',
  expected_delivery_date: '2026-09-15', status: 'draft', subtotal: 0, tax_amount: 0, total: 0, notes: null,
  reference: null, created_at: '2026-09-01T00:00:00Z', items: [],
};
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(cleanup);

const field = (name: RegExp) => screen.getByRole('textbox', { name }) as HTMLInputElement;
const click = (name: RegExp) => fireEvent.click(screen.getByRole('button', { name }));

it.each([
  { label: /^Order Date/, shown: '01 Sep 2026' },
  { label: /^Expected Delivery/, shown: '15 Sep 2026' },
])('an edit cancelled on a refused $label comes back able to save', async ({ label, shown }) => {
  serve(on('PUT', '/purchase-orders/po-1', () => ok(po)), on('GET', '/purchase-orders/po-1', () => ok(po)));
  render(<PurchaseOrderDetailPage />);
  fireEvent.click(await screen.findByRole('button', { name: /^Edit$/ }));
  typeDate(field(label), 'zz');
  await waitFor(() => expect(field(label).getAttribute('aria-invalid')).toBe('true'));
  click(/Cancel/);
  await waitFor(() => expect(screen.queryByRole('textbox', { name: label })).toBeNull());
  click(/^Edit$/);
  expect(field(label).value).toBe(shown);
  expect(field(label).getAttribute('aria-invalid')).toBe('false');
  click(/Save Changes/);
  await waitFor(() => expect(writeCalls('PUT', '/purchase-orders/po-1')).toBe(1));
  expect(screen.queryByText(/Fix the date marked in red/)).toBeNull();
});
