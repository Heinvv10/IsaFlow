/**
 * D2 census, group 1a: list/report pages that called `res.json()` on an unchecked apiFetch response.
 * Per page: a 400 with the real error envelope shows the server's message; a 500 with an EMPTY body
 * shows a plain sentence (never "JSON" / "Unexpected end"); a 200 envelope still renders its data.
 * The real apiFetch helpers (assertOk / apiErrorMessage) run on top of the mocked apiFetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => <button type="button">Export CSV</button> }));

import { apiFetch } from '@/lib/apiFetch';
import ApAgingPage from '../../../pages/accounting/ap-aging/index';
import AssetsPage from '../../../pages/accounting/assets/index';
import CustomerPaymentsPage from '../../../pages/accounting/customer-payments/index';
import DocumentCapturePage from '../../../pages/accounting/document-capture/index';
import ItemOpeningBalancesPage from '../../../pages/accounting/item-opening-balances';
import PurchaseOrdersPage from '../../../pages/accounting/purchase-orders/index';
import ItemValuationReport from '../../../pages/accounting/reports/item-valuation';
import UnallocatedPaymentsReport from '../../../pages/accounting/reports/unallocated-payments';
import SupplierCreditNotesPage from '../../../pages/accounting/supplier-credit-notes/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const MSG = 'D2 server says no: this period is locked';
const ok = (data: unknown, extra: Record<string, unknown> = {}) => new Response(JSON.stringify({ success: true, data, ...extra }), { status: 200 });
const refuse = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const emptyBody = () => new Response('', { status: 500 });

interface Page { name: string; ui: () => ReactElement; url: string; plain: string; good: () => Response; shows: string }
const pages: Page[] = [
  { name: 'ap-aging', ui: () => <ApAgingPage />, url: '/api/accounting/ap-aging?', plain: 'Could not load AP aging - try again',
    good: () => ok([{ entityId: 's1', entityName: 'D2 Supplier Ltd', current: 10, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 10 }]), shows: 'D2 Supplier Ltd' },
  { name: 'assets', ui: () => <AssetsPage />, url: '/api/accounting/assets?', plain: 'Could not load assets - try again',
    good: () => ok([{ id: 'a1', asset_number: 'D2-AST-1', name: 'D2 Laptop', category: 'IT', purchase_price: 100, status: 'available' }]), shows: 'D2 Laptop' },
  { name: 'customer-payments', ui: () => <CustomerPaymentsPage />, url: '/api/accounting/customer-payments?', plain: 'Could not load customer payments - try again',
    good: () => ok({ payments: [{ id: 'p1', paymentNumber: 'D2-PAY-1', clientName: 'D2 Client', paymentDate: '2026-01-01', totalAmount: 10, paymentMethod: 'eft', status: 'confirmed' }], total: 1 }), shows: 'D2-PAY-1' },
  { name: 'document-capture', ui: () => <DocumentCapturePage />, url: '/api/accounting/document-capture?', plain: 'Could not load documents - try again',
    good: () => ok([{ id: 'd1', fileName: 'd2-scan.pdf', originalFilename: 'd2-scan.pdf', status: 'extracted', createdAt: '2026-01-01T00:00:00Z' }], { pagination: { total: 1 } }), shows: 'd2-scan.pdf' },
  { name: 'item-opening-balances', ui: () => <ItemOpeningBalancesPage />, url: '/api/accounting/item-opening-balances', plain: 'Could not load items - try again',
    good: () => ok([{ id: 'i1', item_code: 'D2-ITM-1', name: 'D2 Widget', category: 'c', uom: 'ea', quantity_on_hand: 1, cost_price: 5 }]), shows: 'D2 Widget' },
  { name: 'purchase-orders', ui: () => <PurchaseOrdersPage />, url: '/api/accounting/purchase-orders?', plain: 'Could not load purchase orders - try again',
    good: () => ok([{ id: 'o1', po_number: 'D2-PO-1', supplier_name: 'D2 Supplier', order_date: '2026-01-01', total: 10, status: 'approved' }]), shows: 'D2-PO-1' },
  { name: 'item-valuation', ui: () => <ItemValuationReport />, url: '/api/accounting/reports/item-valuation', plain: 'Could not load item valuation - try again',
    good: () => ok([{ id: 'v1', itemCode: 'D2-VAL-1', name: 'D2 Valued Item', category: 'c', uom: 'ea', qtyOnHand: 1, costPrice: 5, stockValue: 5 }]), shows: 'D2 Valued Item' },
  { name: 'unallocated-payments', ui: () => <UnallocatedPaymentsReport />, url: '/api/accounting/supplier-payments?', plain: 'Could not load unallocated payments - try again',
    good: () => ok([{ id: 'u1', paymentNumber: 'D2-UNA-1', supplierName: 'D2 Payee', date: '2026-01-01', amount: 100, allocatedAmount: 0 }]), shows: 'D2 Payee' },
  { name: 'supplier-credit-notes', ui: () => <SupplierCreditNotesPage />, url: '/api/accounting/supplier-credit-notes?', plain: 'Could not load supplier credit notes - try again',
    good: () => ok({ creditNotes: [{ id: 'c1', creditNoteNumber: 'D2-SCN-1', supplierName: 'D2 Creditor', creditDate: '2026-01-01', totalAmount: 10, status: 'approved' }], total: 1 }), shows: 'D2-SCN-1' },
];

function script(p: Page, answer: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).includes(p.url) ? answer() : ok({})));
}

describe.each(pages)('D2 census 1a: $name', (p) => {
  it('400: the server message from the error envelope is shown', async () => {
    script(p, refuse);
    render(p.ui());
    expect(await screen.findByText(MSG, { exact: false })).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence is shown, not a JSON parse error', async () => {
    script(p, emptyBody);
    const { container } = render(p.ui());
    expect(await screen.findByText(p.plain, { exact: false })).toBeTruthy();
    expect(container.textContent).not.toMatch(/JSON|Unexpected end/i);
  });

  it('200: the data renders', async () => {
    script(p, p.good);
    render(p.ui());
    expect(await screen.findByText(p.shows, { exact: false })).toBeTruthy();
  });
});
