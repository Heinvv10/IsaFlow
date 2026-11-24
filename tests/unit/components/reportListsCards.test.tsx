// Unallocated supplier payments / customer receipts and the item listing: the table becomes labelled cards below lg (first column = card heading),
// headers wrap, and the header actions are 44px touch targets.
import type { ReactNode } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ data: [] as unknown[] }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/apiFetch', async (orig) => ({
  ...(await orig<typeof import('@/lib/apiFetch')>()),
  apiFetch: vi.fn(async () => new Response(JSON.stringify({ success: true, data: state.data }), { status: 200, headers: { 'Content-Type': 'application/json' } })),
}));

import Payments from '../../../pages/accounting/reports/unallocated-payments';
import Receipts from '../../../pages/accounting/reports/unallocated-receipts';
import ItemListing from '../../../pages/accounting/reports/item-listing';

afterEach(() => { cleanup(); state.data = []; });
const cls = (el: Element) => el.className.split(' ');
const pay = (n: string, party: string, over: Record<string, unknown> = {}) => ({ id: n, paymentNumber: `PAY-${n}`, [party]: `Party ${n}`, date: '2026-11-01', amount: 1000, allocatedAmount: 400, ...over });
const item = (n: string) => ({ id: n, itemCode: `IT-${n}`, name: `Item ${n}`, category: 'Cables', uom: 'm', sellingPrice: 200, costPrice: 120, qtyOnHand: 15, isActive: true });

const CASES: Array<{ name: string; Page: () => JSX.Element; rows: () => unknown[]; first: string; labels: string[]; action?: string }> = [
  { name: 'unallocated supplier payments', Page: Payments, rows: () => [pay('1', 'supplierName'), pay('2', 'supplierName')], first: 'PAY-1', labels: ['Payment No', 'Supplier', 'Date', 'Total', 'Allocated', 'Unallocated'], action: 'Allocate Payments' },
  { name: 'unallocated customer receipts', Page: Receipts, rows: () => [pay('1', 'clientName'), pay('2', 'clientName')], first: 'PAY-1', labels: ['Receipt No', 'Customer', 'Date', 'Total', 'Allocated', 'Unallocated'], action: 'Allocate Receipts' },
  { name: 'item listing', Page: ItemListing, rows: () => [item('1'), item('2')], first: 'IT-1', labels: ['Code', 'Name', 'Category', 'UOM', 'Selling', 'Cost', 'Qty'] },
];

describe.each(CASES)('$name on touch', ({ Page, rows, first, labels, action }) => {
  it('is labelled cards matching the headers, first column unlabelled as the heading', async () => {
    state.data = rows();
    const { container } = render(<Page />);
    await screen.findByText(first);
    const table = container.querySelector('table')!;
    expect(cls(table)).toContain('table-cards');
    expect([...table.querySelectorAll('thead th')].map((th) => th.textContent)).toEqual(labels);
    const trs = [...table.querySelectorAll('tbody tr')];
    expect(trs).toHaveLength(2);
    for (const r of trs) expect([...r.querySelectorAll('td')].map((td) => td.getAttribute('data-label'))).toEqual([null, ...labels.slice(1)]);
  });

  it('the header row wraps', async () => {
    state.data = rows();
    render(<Page />);
    await screen.findByText(first);
    expect(cls(screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:gap-3']));
    if (action) expect(cls(screen.getByRole('link', { name: action }))).toEqual(expect.arrayContaining(['max-lg:min-h-11', 'max-lg:inline-flex', 'max-lg:items-center']));
  });
});

describe('item listing header controls', () => {
  it('search and CSV are 44px and the control group takes the full row', async () => {
    state.data = [item('1')];
    render(<ItemListing />);
    await screen.findByText('IT-1');
    const search = screen.getByPlaceholderText('Search...');
    expect(cls(search)).toContain('max-lg:min-h-11');
    expect(cls(screen.getByRole('button', { name: /CSV/ }))).toContain('max-lg:min-h-11');
    expect(cls(search.parentElement!.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-wrap', 'max-lg:w-full']));
    expect(cls(search.parentElement!)).toEqual(expect.arrayContaining(['max-lg:flex-1', 'max-lg:min-w-0']));
  });
});
