/**
 * The purchase order and supplier invoice forms on a phone: the fields and the summary stack, and the line table
 * scrolls inside a named, focusable region with its Remove button on show (a phone has no hover). happy-dom has no
 * layout, so these pin the classes that do the stacking; the golden at 390 (y8) measures the real thing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' } }) }));

import { apiFetch } from '@/lib/apiFetch';
import NewPurchaseOrderPage from '../../../pages/accounting/purchase-orders/new';
import NewSupplierInvoicePage from '../../../pages/accounting/supplier-invoices/new';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockImplementation(async () => ok([])); });
afterEach(cleanup);

/** Nearest ancestor (or self) whose classes contain `part`. */
const closest = (el: Element, part: string): Element | null => (el.className.toString().includes(part) ? el : el.parentElement && closest(el.parentElement, part));

const FORMS = [
  { name: 'purchase order', page: <NewPurchaseOrderPage />, summary: 'Order Summary', lines: 'Purchase order lines', dateA: /order date/i, dateB: /expected delivery/i },
  { name: 'supplier invoice', page: <NewSupplierInvoicePage />, summary: 'Summary', lines: 'Invoice lines', dateA: /invoice date/i, dateB: /due date/i },
];

describe.each(FORMS)('$name form at a narrow width', ({ page, summary, lines, dateA, dateB }) => {
  it('the dates sit in one column until sm', () => {
    render(page);
    const grid = closest(screen.getByRole('textbox', { name: dateA }), 'grid-cols-')!;
    expect(grid.contains(screen.getByRole('textbox', { name: dateB }))).toBe(true);
    expect(grid.className).toContain('grid-cols-1');
    expect(grid.className).toContain('sm:grid-cols-2');
  });

  it('the summary stacks under the form until lg, and is sticky only beside it', () => {
    render(page);
    const column = closest(screen.getByRole('heading', { name: summary, exact: true }), 'sticky')!;
    expect(column.className).toContain('lg:sticky');
    expect(column.className).not.toMatch(/(^|\s)sticky/);
    const layout = column.parentElement!;
    expect(layout.className).toContain('grid-cols-1');
    expect(layout.className).toContain('lg:grid-cols-[1fr_320px]');
    expect(column.className).not.toContain('w-72');
  });

  it('the line table is a focusable scroll region with a named, always visible Remove', () => {
    render(page);
    const region = screen.getByRole('region', { name: lines });
    expect(region.getAttribute('tabindex')).toBe('0');
    expect(region.className).toContain('overflow-x-auto');
    expect(within(region).getByRole('table').className).toContain('min-w-[720px]');
    expect(within(region).getByRole('button', { name: 'Remove line' }).className).not.toContain('opacity-0');
    expect(screen.getByText('Scroll sideways to see every column.').className).toContain('md:hidden');
  });
});
