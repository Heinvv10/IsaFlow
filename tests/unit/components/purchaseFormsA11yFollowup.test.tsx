/**
 * Wave-2 a11y follow-up on the purchase order and supplier invoice forms: the sideways-scroll hint shows exactly when
 * the line table overflows, remove buttons name their row, the icon is legible, and a refused date disables submit.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok } from '../helpers/d2CensusG4';
import { typeDate } from '../helpers/dateFields';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(async () => true), replace: vi.fn(), pathname: '/', isReady: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/modules/accounting/documents', () => ({ AccountingDocumentPanel: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({
  SupplierSelect: () => <span>supplier</span>,
}));

import { apiFetch } from '@/lib/apiFetch';
import PoNew from '../../../pages/accounting/purchase-orders/new';
import SupplierInvoiceNew from '../../../pages/accounting/supplier-invoices/new';
import { BillLineItemsTable, type BillLineItem } from '@/components/accounting/suppliers/BillLineItemsTable';

useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(apiFetch).mockImplementation(async () => ok([])); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const HINT = /Scroll sideways/;
const line = (key: string): BillLineItem => ({ key, description: 'x', quantity: 1, unitPrice: 10, taxRate: 15, glAccountId: '' });
const table = (lines: BillLineItem[]) => (
  <BillLineItemsTable lines={lines} glAccounts={[]} onAdd={vi.fn()} onUpdate={vi.fn()} onRemove={vi.fn()} />
);

/** jsdom has no layout: stand in for a region whose content is wider than the box, and a ResizeObserver we can fire. */
function stubLayout(scrollWidth: number, clientWidth: number): { fire: () => void; setWidths: (s: number, c: number) => void } {
  let s = scrollWidth; let c = clientWidth;
  const callbacks: (() => void)[] = [];
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockImplementation(() => s);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => c);
  vi.stubGlobal('ResizeObserver', class { constructor(cb: () => void) { callbacks.push(cb); } observe() {} unobserve() {} disconnect() {} });
  return { fire: () => callbacks.forEach((cb) => cb()), setWidths: (a, b) => { s = a; c = b; } };
}

describe('sideways-scroll hint', () => {
  it('shows on every width where the line table overflows, and only then', async () => {
    const layout = stubLayout(720, 600);
    render(table([line('a')]));
    await waitFor(() => expect(screen.getByText(HINT)).toBeTruthy());
    layout.setWidths(720, 720);
    layout.fire();
    await waitFor(() => expect(screen.queryByText(HINT)).toBeNull());
  });

  it('is absent when nothing overflows', () => {
    stubLayout(720, 720);
    render(table([line('a')]));
    expect(screen.queryByText(HINT)).toBeNull();
  });

  it('the purchase order form uses it too', async () => {
    stubLayout(720, 600);
    render(<PoNew />);
    await waitFor(() => expect(screen.getByText(HINT)).toBeTruthy());
  });
});

describe('remove line buttons', () => {
  it('bill lines name their row', () => {
    render(table([line('a'), line('b')]));
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove line 2' })).toBeTruthy();
  });

  it('bill line icon is darker than slate-400 in both themes', () => {
    render(table([line('a')]));
    const cls = screen.getByRole('button', { name: 'Remove line 1' }).className;
    expect(cls).not.toMatch(/(^|\s)text-slate-400/);
    expect(cls).toMatch(/(^|\s)text-slate-(600|700)(\s|$)/);
    expect(cls).toMatch(/dark:text-slate-(300|400)(\s|$)/);
  });

  it('purchase order lines name their row', () => {
    render(<PoNew />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Line' }));
    expect(screen.getByRole('button', { name: 'Remove line 1' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove line 2' })).toBeTruthy();
  });
});

describe.each([
  { name: 'purchase order', element: <PoNew />, date: 'Order Date', buttons: ['Create Purchase Order', 'Save & New'] },
  { name: 'supplier invoice', element: <SupplierInvoiceNew />, date: 'Invoice Date', buttons: ['Create Invoice'] },
])('$name submit', ({ element, date, buttons }) => {
  const field = () => screen.getByRole('textbox', { name: new RegExp(`^${date}`, 'i') });
  const button = (n: string) => screen.getByRole('button', { name: n }) as HTMLButtonElement;

  it('is enabled with a good date', () => {
    render(element);
    for (const b of buttons) expect(button(b).disabled).toBe(false);
  });

  it('is disabled while the date is refused and enabled again once fixed', () => {
    render(element);
    typeDate(field(), 'zz');
    for (const b of buttons) expect(button(b).disabled).toBe(true);
    typeDate(field(), '6 Oct 2031');
    for (const b of buttons) expect(button(b).disabled).toBe(false);
  });
});
