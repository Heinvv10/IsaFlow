/**
 * D2 census group 5: loads and saves that called res.json() on a response nobody had checked. Each case
 * answers the request under test with (1) the real 400 error envelope, (2) an empty-body 500 and (3) a
 * good 200 whose data must render. Every other request answers with a valid empty success envelope.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));

import { apiFetch } from '@/lib/apiFetch';
import BelowThresholdPage from '../../../pages/accounting/assets/below-threshold';
import SalesOrdersPage from '../../../pages/accounting/customer-sales-orders/index';
import NewGRNPage from '../../../pages/accounting/goods-received/new';
import ItemAdjustmentsPage from '../../../pages/accounting/item-adjustments';
import NewProductPage from '../../../pages/accounting/products/new';
import SubmissionsPage from '../../../pages/accounting/sars/submissions';
import { AssetLocationSelect } from '../../../src/components/accounting/AssetLocationSelect';
import { AutoPostRunsPanel } from '../../../src/components/accounting/bank-transactions/AutoPostRunsPanel';
import { ReportBuilderSidebar } from '../../../src/components/accounting/reports/ReportBuilderSidebar';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const envelope = (m: string) => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: m } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
const MSG = 'D2 server says no: this data is not available';

interface Case {
  name: string;
  page: () => JSX.Element;
  /** The request that fails; every other request answers with `rest`. */
  fails: (url: string, method: string) => boolean;
  good: unknown;
  rest?: (url: string) => unknown;
  /** What the user does once the page has settled, before the failure can show. */
  act?: () => Promise<void>;
  shows: RegExp;
  plain: RegExp;
}

const PO = { id: 'po-1', po_number: 'PO-D2-1', supplier_name: 'D2 Supplier', total: 10 };
const STOCK = { id: 'i1', item_code: 'D2-ITEM', item_name: 'D2 Widget', uom: 'ea', current_quantity: 5 };

const CASES: Case[] = [
  { name: 'below-threshold assets', page: () => <BelowThresholdPage />, fails: () => true,
    good: [{ id: 'a1', asset_number: 'A-D2-1', name: 'D2 Stapler', cost: 10, threshold: 100, category_name: null, status: 'active',
      created_at: '2026-01-01', belowThreshold: true, expensed: false, suggestedTreatment: 'expense' }],
    shows: /A-D2-1/, plain: /Could not load assets - try again/ },
  { name: 'sales orders: customer list in the New modal', page: () => <SalesOrdersPage />,
    fails: u => u.endsWith('/accounting/customers'), good: [{ id: 'c1', name: 'D2 Customer Ltd' }],
    rest: u => (u.includes('customer-sales-orders') ? { orders: [], total: 0 } : []),
    act: async () => { fireEvent.click((await screen.findAllByRole('button', { name: /New Sales Order/ }))[0]); },
    shows: /D2 Customer Ltd/, plain: /Could not load customers - try again/ },
  { name: 'new GRN: purchase order lines', page: () => <NewGRNPage />,
    fails: u => u.includes('/purchase-orders/po-1'), good: { items: [{ id: 'l1', description: 'D2 Bolt line', quantity: 4, quantity_received: 0 }] },
    rest: u => (u.includes('/purchase-orders/') ? {} : u.includes('status=approved') ? [PO] : []),
    act: async () => { await screen.findByText(/PO-D2-1/); fireEvent.change(screen.getByRole('combobox'), { target: { value: 'po-1' } }); },
    shows: /D2 Bolt line/, plain: /Could not load the purchase order - try again/ },
  { name: 'item adjustments: save', page: () => <ItemAdjustmentsPage />, fails: (_u, m) => m === 'POST', good: {},
    rest: () => [STOCK],
    act: async () => {
      fireEvent.click(await screen.findByRole('button', { name: /New Adjustment/ }));
      await screen.findByText('D2 Widget');
      const [item] = screen.getAllByRole('combobox');
      fireEvent.change(item, { target: { value: 'i1' } });
      fireEvent.change(screen.getByPlaceholderText(/Physical count/), { target: { value: 'count' } });
      fireEvent.change(document.querySelector('input[type="number"]') as HTMLInputElement, { target: { value: '2' } });
      fireEvent.submit(screen.getByRole('button', { name: 'Save' }).closest('form') as HTMLFormElement);
    },
    shows: /Adjustment saved/, plain: /Could not save the adjustment - try again/ },
  { name: 'new product: categories', page: () => <NewProductPage />, fails: u => u.includes('products-categories'),
    good: [{ id: 'k1', name: 'D2 Category', code: 'D2C' }], shows: /D2 Category/, plain: /Could not load product categories - try again/ },
  { name: 'SARS submissions list', page: () => <SubmissionsPage />, fails: () => true,
    good: { items: [{ id: 's1', formType: 'D2-VAT201', periodStart: '2026-01-01', periodEnd: '2026-01-31', status: 'draft', formData: {},
      submissionReference: null, submittedAt: null, notes: null, createdAt: '2026-02-01', updatedAt: '2026-02-01', submittedBy: null }] },
    shows: /D2-VAT201/, plain: /Could not load submissions - try again/ },
  { name: 'asset location select', page: () => <AssetLocationSelect value="" onChange={vi.fn()} />, fails: () => true,
    good: [{ id: 'l1', name: 'D2 Warehouse' }], shows: /D2 Warehouse/, plain: /Could not load locations - try again/ },
  { name: 'auto-post runs panel', page: () => <AutoPostRunsPanel />, fails: () => true,
    good: { runs: [{ id: 'r1', source: 'd2-source', postedCount: 3, totalAmount: 10, createdAt: '2026-01-01', undoneAt: null }] },
    shows: /d2-source/, plain: /Could not load recent auto-post runs - try again/ },
  { name: 'report builder field list', page: () => <ReportBuilderSidebar selectedSource="customers" selectedFields={[]} onSourceChange={vi.fn()} onAddField={vi.fn()} />,
    fails: () => true, good: { fields: [{ field: 'f1', label: 'D2 Field Label', type: 'text', sortable: true, filterable: true, totalable: false }] },
    shows: /D2 Field Label/, plain: /Could not load fields - try again/ },
];

function script(c: Case, answer: () => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    if (c.fails(u, init?.method ?? 'GET')) return answer();
    return ok(c.rest ? c.rest(u) : []);
  });
}

describe.each(CASES)('$name', (c) => {
  it('400: the server message is shown', async () => {
    script(c, () => envelope(MSG));
    render(c.page());
    await c.act?.();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });

  it('500 with an empty body: a plain sentence, not a JSON parse error', async () => {
    script(c, empty500);
    render(c.page());
    await c.act?.();
    expect(await screen.findByText(c.plain)).toBeTruthy();
    expect(screen.queryByText(/JSON|Unexpected end/)).toBeNull();
  });

  it('200: the data renders', async () => {
    script(c, () => ok(c.good));
    render(c.page());
    await c.act?.();
    expect((await screen.findAllByText(c.shows)).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Could not (load|save)|D2 server says no/)).toBeNull();
  });
});
