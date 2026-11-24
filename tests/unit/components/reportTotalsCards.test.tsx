// The six report tables with a total row (item movement/valuation, purchases/sales by item, purchases by supplier, sales by customer):
// labelled cards below lg (first column = card heading), header and its actions wrap, CSV is 44px; the total row's cells carry their column's label
// and an empty total cell is hidden in card mode.
import type { ReactNode } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.data }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Movement from '../../../pages/accounting/reports/item-movement';
import Valuation from '../../../pages/accounting/reports/item-valuation';
import PurchasesByItem from '../../../pages/accounting/reports/purchases-by-item';
import SalesByItem from '../../../pages/accounting/reports/sales-by-item';
import PurchasesBySupplier from '../../../pages/accounting/reports/purchases-by-supplier';
import SalesByCustomer from '../../../pages/accounting/reports/sales-by-customer';

afterEach(() => { cleanup(); state.data = []; });
const cls = (el: Element) => el.className.split(' ');
const itemRow = (n: string, extra: Record<string, unknown>) => ({ id: n, itemCode: `IT-${n}`, name: `Item ${n}`, category: 'Cables', uom: 'm', ...extra });

interface Case { name: string; Page: () => JSX.Element; rows: () => unknown[]; first: string; heads: RegExp[]; footLabels?: string[]; hiddenFoot?: number }
const CASES: Case[] = [
  { name: 'item movement', Page: Movement, first: 'REF-1', rows: () => [1, 2].map((n) => ({ date: '2026-11-01', type: 'GRN', reference: `REF-${n}`, itemCode: `IT-${n}`, itemName: `Item ${n}`, qtyIn: 5, qtyOut: 0, balance: 5 })), heads: [/Date/, /Type/, /Reference/, /Item/, /In/, /Out/, /Balance/] },
  { name: 'item valuation', Page: Valuation, first: 'IT-1', rows: () => [1, 2].map((n) => itemRow(String(n), { qtyOnHand: 10, costPrice: 100, stockValue: 1000 })), heads: [/Code/, /Item/, /Category/, /UOM/, /Qty/, /Unit Cost/, /Value/], footLabels: ['Value'] },
  { name: 'purchases by item', Page: PurchasesByItem, first: 'IT-1', rows: () => [1, 2].map((n) => itemRow(String(n), { poCount: 2, qtyOrdered: 10, totalCost: 500, avgCost: 50 })), heads: [/Code/, /Item/, /Category/, /POs/, /Qty Ordered/, /Total Cost/, /Avg Cost/], footLabels: ['Qty Ordered', 'Total Cost'], hiddenFoot: 1 },
  { name: 'sales by item', Page: SalesByItem, first: 'IT-1', rows: () => [1, 2].map((n) => itemRow(String(n), { timesSold: 2, qtySold: 10, totalRevenue: 500, avgPrice: 50 })), heads: [/Code/, /Item/, /Category/, /Times Sold/, /Qty Sold/, /Revenue/, /Avg Price/], footLabels: ['Qty Sold', 'Revenue'], hiddenFoot: 1 },
  { name: 'purchases by supplier', Page: PurchasesBySupplier, first: 'Supplier 1', rows: () => [1, 2].map((n) => ({ supplierId: `s${n}`, supplierName: `Supplier ${n}`, invoiceCount: 3, totalPurchases: 900, paymentsMade: 400, outstanding: 500 })), heads: [/Supplier/, /Invoices/, /Total Purchases/, /Paid at/, /Outstanding at/], footLabels: ['Invoices', 'Total Purchases', 'Paid at', 'Outstanding at'] },
  { name: 'sales by customer', Page: SalesByCustomer, first: 'Customer 1', rows: () => [1, 2].map((n) => ({ clientId: `c${n}`, clientName: `Customer ${n}`, invoiceCount: 3, totalSales: 900, paymentsReceived: 400, outstanding: 500 })), heads: [/Customer/, /Invoices/, /Total Sales/, /Received at/, /Outstanding at/], footLabels: ['Invoices', 'Total Sales', 'Received at', 'Outstanding at'] },
];

describe.each(CASES)('$name on touch', ({ Page, rows, first, heads, footLabels, hiddenFoot }) => {
  it('is labelled cards matching the headers, first column unlabelled as the heading', async () => {
    state.data = rows();
    const { container } = render(<Page />);
    await screen.findByText(first);
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    const ths = [...table.querySelectorAll('thead th')].map((th) => th.textContent ?? '');
    expect(ths).toHaveLength(heads.length);
    heads.forEach((re, i) => expect(ths[i]).toMatch(re));
    const trs = [...table.querySelectorAll('tbody tr')];
    expect(trs).toHaveLength(2);
    for (const r of trs) {
      const labels = [...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'));
      expect(labels[0]).toBeNull();
      labels.slice(1).forEach((l, i) => expect(l).toBe(ths[i + 1]));
    }
  });

  it('the total row: value cells carry their column label, empty cells are hidden in card mode', async () => {
    state.data = rows();
    const { container } = render(<Page />);
    await screen.findByText(first);
    const foot = container.querySelector('tfoot');
    if (!footLabels) { expect(foot).toBeNull(); return; }
    const labelled = [...foot!.querySelectorAll('td[data-label]')].map((td) => td.getAttribute('data-label'));
    expect(labelled).toHaveLength(footLabels.length);
    footLabels.forEach((l, i) => expect(labelled[i]).toContain(l));
    expect(foot!.querySelectorAll('td[class*="max-lg:!hidden"]')).toHaveLength(hiddenFoot ?? 0);
    expect(foot!.querySelector('td')!.hasAttribute('data-label')).toBe(false);
  });

  it('the header row and its actions wrap and CSV is a 44px target', async () => {
    state.data = rows();
    render(<Page />);
    await screen.findByText(first);
    const csv = screen.getByRole('button', { name: /CSV/ });
    expect(cls(csv)).toContain('max-lg:min-h-11');
    await waitFor(() => expect(cls(csv.parentElement!)).toContain('max-lg:flex-wrap'));
    expect(cls(csv.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
  });
});
