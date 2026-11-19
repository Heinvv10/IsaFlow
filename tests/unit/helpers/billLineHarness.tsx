/**
 * Shared setup for the supplier-bill line table tests. jsdom has no layout, so `stubLayout` stands in for the
 * measured widths: the box the table measures (`[data-lines-box]`) reads `width()`, and the scrolling region reads
 * the same minus the 2px its border takes in table mode, as the browser does. `ResizeObserver` is a stub whose
 * callbacks `fire()` runs, so a test can drive the width and replay the observer after every swap.
 */
import { act } from '@testing-library/react';
import { vi } from 'vitest';
import type { BillLineItem, GLAccount } from '@/components/accounting/suppliers/BillLineItemsTable';
import type { InvoiceLineCodingOptions } from '@/components/accounting/customer-invoices/useInvoiceLineCodingOptions';

export const T = 820;
export const T_DIM = 1060;

export function stubLayout(initial: number, tableOverflow = 0) {
  let w = initial;
  const callbacks: (() => void)[] = [];
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    if (this.hasAttribute('data-lines-box')) return w;
    if (this.getAttribute('role') === 'region') return w - (this.querySelector('table') ? 2 : 0);
    return 0;
  });
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.clientWidth + (this.getAttribute('role') === 'region' && this.querySelector('table') ? tableOverflow : 0);
  });
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { callbacks.push(cb); } observe() {} unobserve() {} disconnect() {} });
  const fire = () => act(() => { callbacks.forEach((cb) => cb()); });
  return {
    fire,
    /** Set the box width, then replay the observer `times` (it fires again after every swap in a browser). */
    set(next: number, times = 6) { w = next; for (let i = 0; i < times; i++) fire(); },
  };
}

export const line = (key: string, over: Partial<BillLineItem> = {}): BillLineItem =>
  ({ key, description: '', quantity: 1, unitPrice: 0, taxRate: 0, glAccountId: '', ...over });

export const accounts: GLAccount[] = [
  { id: 'a1', accountCode: '5100', accountName: 'Cost of sales', accountType: 'expense' },
  { id: 'a2', accountCode: '6000', accountName: 'Salaries & Wages', accountType: 'expense' },
];

export const coding = (): InvoiceLineCodingOptions => ({
  accounts: [], projects: [], cc2s: [{ id: 'p1', label: 'P1 Project' }], bus: [{ id: 'b1', label: 'B1 Unit' }],
  known: {}, status: 'ready', lookupFailed: false, error: '', retry: vi.fn(),
});

export const ladderBody = (items: unknown[]) => ({ items });
