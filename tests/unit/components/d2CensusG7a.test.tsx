/**
 * d2 census group 7 (a): detail pages that loaded with `apiFetch(...).json()` and no `res.ok` check.
 * Each answers a 400 envelope, an empty 500 and a 200, through the real apiFetch helpers.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, NO_RAW, serve, type Kind } from '../helpers/d2CensusG7Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/assets/AssetDualTrackPanel', () => ({ AssetDualTrackPanel: () => null }));
const route = { query: {} as Record<string, string>, push: vi.fn(), isReady: true };
vi.mock('next/router', () => ({ useRouter: () => route }));

import AssetDetailPage from '../../../pages/accounting/assets/[assetId]';
import BatchPaymentDetailPage from '../../../pages/accounting/batch-payments/[batchId]';
import ProductDetailPage from '../../../pages/accounting/products/[productId]';
import PurchaseOrderDetailPage from '../../../pages/accounting/supplier-purchase-orders/[poId]';
import DeliveryNotesPage from '../../../pages/accounting/delivery-notes/index';
import CustomerCategoriesPage from '../../../pages/accounting/customer-categories/index';
import ItemAdjustmentsPage from '../../../pages/accounting/item-adjustments';
import ItemMovementReport from '../../../pages/accounting/reports/item-movement';
import SupplierPosReport from '../../../pages/accounting/reports/supplier-pos';
import CustomerQuotesPage from '../../../pages/accounting/customer-quotes/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const asset = { id: 'a1', asset_number: 'FA-D2-1', name: 'D2 Server Rack', status: 'active', category: null, purchase_date: null,
  purchase_price: null, current_book_value: null, useful_life_years: null, location: null, serial_number: null,
  supplier_name: null, sars_category: null, sars_rate: null, tax_life: null, created_at: '2026-01-01', salvage_value: null, depreciation_method: null };

interface Site {
  name: string; match: string; page: () => React.ReactElement; query?: Record<string, string>;
  okBody: unknown; shows: string; plain: RegExp; others?: unknown;
}
const SITES: Site[] = [
  { name: 'asset detail', match: '/api/accounting/assets', page: () => <AssetDetailPage />, query: { assetId: 'a1' },
    okBody: [asset], shows: 'D2 Server Rack', plain: /could not load the asset/i },
  { name: 'batch payment detail', match: '/api/accounting/batch-payments?id=', page: () => <BatchPaymentDetailPage />, query: { batchId: 'b1' },
    okBody: { id: 'b1', batchNumber: 'BATCH-D2-77', batchDate: '2026-01-01', totalAmount: 1, paymentCount: 0, paymentMethod: 'eft', status: 'draft', payments: [] },
    shows: 'BATCH-D2-77', plain: /could not load the batch/i },
  { name: 'product detail', match: '/api/accounting/products', page: () => <ProductDetailPage />, query: { productId: 'p1' },
    okBody: [{ id: 'p1', sku: 'SKU-D2', name: 'D2 Widget', description: null, category_name: null, selling_price: null, cost_price: null, qty_on_hand: null, is_active: true, created_at: '2026-01-01' }],
    shows: 'D2 Widget', plain: /could not load the product/i },
  { name: 'supplier purchase order detail', match: '/api/accounting/supplier-purchase-orders', page: () => <PurchaseOrderDetailPage />, query: { poId: 'po1' },
    okBody: [{ id: 'po1', po_number: 'PO-D2-55', supplier_name: null, order_date: null, expected_delivery_date: null, status: 'draft', subtotal: null, tax_amount: null, total_amount: null, notes: null, created_at: '2026-01-01' }],
    shows: 'PO-D2-55', plain: /could not load the purchase order/i },
  { name: 'delivery notes list', match: '/api/accounting/delivery-notes', page: () => <DeliveryNotesPage />,
    okBody: { notes: [{ id: 'd1', deliveryNoteNumber: 'DN-D2-9', customerName: 'D2 Customer', deliveryDate: '2026-01-01', status: 'draft', lineCount: 1 }], total: 1 },
    shows: 'DN-D2-9', plain: /could not load delivery notes/i },
  { name: 'customer categories', match: '/api/accounting/customer-categories', page: () => <CustomerCategoriesPage />,
    okBody: [{ id: 'c1', name: 'D2 Category', description: '', clientCount: 3 }], shows: 'D2 Category', plain: /could not load categories/i },
  { name: 'item adjustments', match: '/api/accounting/item-adjustments', page: () => <ItemAdjustmentsPage />,
    okBody: [{ id: 'i1', item_code: 'D2-ITEM', item_name: 'D2 Item', uom: 'ea', current_quantity: 5 }], shows: 'D2 Item', plain: /could not load items/i },
  { name: 'item movement report', match: '/api/accounting/reports/item-movement', page: () => <ItemMovementReport />,
    okBody: [{ date: '2026-01-01', type: 'in', reference: 'REF-D2-MOVE', itemCode: 'X', itemName: 'D2 Mover', qtyIn: 1, qtyOut: 0, balance: 1 }],
    shows: 'REF-D2-MOVE', plain: /could not load the report/i },
  { name: 'supplier POs report', match: '/api/accounting/reports-supplier-pos', page: () => <SupplierPosReport />,
    okBody: { suppliers: [{ supplierId: 's1', supplierName: 'D2 Supplier Ltd', poCount: 1, totalValue: 10, pos: [] }], grandPoCount: 1, grandTotal: 10 },
    shows: 'D2 Supplier Ltd', plain: /could not load the report/i },
  { name: 'customer quotes list', match: '/api/accounting/customer-quotes?', page: () => <CustomerQuotesPage />,
    okBody: { quotes: [{ id: 'q1', quoteNumber: 'QT-D2-31', customerName: 'D2 Customer', quoteDate: '2026-01-01', expiryDate: null, status: 'draft', total: 10 }], total: 1 },
    shows: 'QT-D2-31', plain: /could not load quotes/i },
];

const run = (s: Site, kind: Kind) => {
  Object.keys(route.query).forEach(k => delete route.query[k]);
  Object.assign(route.query, s.query ?? {});
  serve(s.match, kind, s.okBody, s.others ?? []);
  render(s.page());
};

describe.each(SITES)('$name', (s) => {
  it('shows the server message on a 400 envelope', async () => {
    run(s, 'bad');
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });
  it('shows a plain sentence, not JSON text, on an empty 500', async () => {
    run(s, 'empty500');
    expect(await screen.findByText(s.plain)).toBeTruthy();
    expect(NO_RAW()).toBe(true);
  });
  it('renders the data on a 200', async () => {
    run(s, 'ok');
    expect((await screen.findAllByText(new RegExp(s.shows))).length).toBeGreaterThan(0);
  });
});
