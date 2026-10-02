/**
 * D2 round 3 (a1): item pricing / opening balances / adjustments, items list, supplier allocations.
 * A refused write shows the server message and no success; an empty 500 a plain sentence; a write that
 * succeeds followed by a failed reload keeps the success, shows the reload error and clears the spinner.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route, spinning } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/ui', () => ({ KpiStrip: () => null }));
const company = vi.hoisted(() => ({ activeCompany: { id: 'co-1', name: 'D2 Co' } }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => company }));

import ItemPricingPage from '../../../pages/accounting/item-pricing';
import ItemOpeningBalancesPage from '../../../pages/accounting/item-opening-balances';
import ItemAdjustmentsPage from '../../../pages/accounting/item-adjustments';
import ItemsListPage from '../../../pages/accounting/items/index';
import SupplierAllocationsPage from '../../../pages/accounting/supplier-allocations/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); });

const ITEM = { id: 'i1', item_code: 'D2-001', name: 'D2 Widget', item_name: 'D2 Widget', category: 'c', uom: 'ea',
  selling_price: 10, cost_price: 5, quantity_on_hand: 3, current_quantity: 3 };

/** GET answers: first `ok([ITEM])`, then `reload()`; the write answers `write()`. */
function script(base: string, write: () => Response, reload: () => Response) {
  let gets = 0;
  route((url, method) => {
    if (!url.includes(base)) return ok([]);
    if (method === 'GET') { gets += 1; return gets === 1 ? ok([ITEM]) : reload(); }
    return write();
  });
}

interface WriteCase {
  name: string; base: string; page: () => JSX.Element; success: RegExp; plain: RegExp; reloadPlain: RegExp;
  /** Edit then trigger the write. */
  act: (container: HTMLElement) => void | Promise<void>;
}
const CASES: WriteCase[] = [
  { name: 'item pricing', base: '/api/accounting/item-pricing', page: () => <ItemPricingPage />, success: /1 price\(s\) updated/,
    plain: /Could not save the prices - try again/, reloadPlain: /Could not reload items - try again/,
    act: async () => { fireEvent.change(await screen.findByRole('spinbutton'), { target: { value: '20' } });
      fireEvent.click(await screen.findByRole('button', { name: /Save \(1\)/ })); } },
  { name: 'item opening balances', base: '/api/accounting/item-opening-balances', page: () => <ItemOpeningBalancesPage />,
    success: /Balances set for 1 item/, plain: /Could not save the opening balances - try again/, reloadPlain: /Could not reload items - try again/,
    act: async () => { fireEvent.change((await screen.findAllByRole('spinbutton'))[0]!, { target: { value: '9' } });
      fireEvent.click(await screen.findByRole('button', { name: /Save \(1\)/ })); } },
  { name: 'item adjustments', base: '/api/accounting/item-adjustments', page: () => <ItemAdjustmentsPage />,
    success: /Adjustment saved/, plain: /Could not save the adjustment - try again/, reloadPlain: /Could not reload items - try again/,
    act: async (c) => { await screen.findByText('D2 Widget'); fireEvent.click(screen.getByRole('button', { name: /New Adjustment/ }));
      fireEvent.submit(c.querySelector('form')!); } },
];

describe.each(CASES)('$name write', (c) => {
  it('a refused write shows the server message, no success, and re-enables saving', async () => {
    script(c.base, () => bad(), () => ok([ITEM]));
    const { container } = render(c.page());
    await c.act(container);
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.queryByText(c.success)).toBeNull();
    await waitFor(() => expect(spinning()).toBe(false));
  });
  it('an empty 500 write shows a plain sentence', async () => {
    script(c.base, empty500, () => ok([ITEM]));
    const { container } = render(c.page());
    await c.act(container);
    expect(await screen.findByText(c.plain)).toBeTruthy();
    expect(noRawText()).toBe(true);
    expect(screen.queryByText(c.success)).toBeNull();
  });
  it('write 200 then reload 500 keeps the success, shows the reload error, clears the spinner', async () => {
    script(c.base, () => ok({}), empty500);
    const { container } = render(c.page());
    await c.act(container);
    expect(await screen.findByText(c.success)).toBeTruthy();
    expect(await screen.findByText(/Could not load items - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
    await waitFor(() => expect(spinning()).toBe(false));
    expect(screen.queryByText('D2 Widget')).toBeNull();
  });
  it('a failed first load shows a plain sentence and no spinner', async () => {
    route((url) => (url.includes(c.base) ? empty500() : ok([])));
    render(c.page());
    expect(await screen.findByText(/Could not load items - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
    expect(spinning()).toBe(false);
  });
});

describe('items list: a categories failure survives an items reload', () => {
  it('keeps the categories error when a filter change reloads the items', async () => {
    route((url) => (url.includes('/item-categories') ? bad() : ok([])));
    const { container } = render(<ItemsListPage />);
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    await waitFor(() => expect(spinning()).toBe(false));
    fireEvent.change(container.querySelectorAll('select')[0]!, { target: { value: 'service' } });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([u]) => String(u).includes('type=service'))).toBe(true));
    await waitFor(() => expect(spinning()).toBe(false));
    expect(screen.getByText(new RegExp(MSG))).toBeTruthy();
  });
  it('shows the items error and the categories error side by side', async () => {
    route((url) => (url.includes('/item-categories') ? bad() : empty500()));
    render(<ItemsListPage />);
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(await screen.findByText(/Could not load items - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
});

describe('supplier allocations', () => {
  const PAY = { id: 'p1', paymentNumber: 'PAY-D2-1', supplierName: 'D2 Supplier', supplierId: 's1', date: '2026-01-01', amount: 100, allocatedAmount: 0 };
  const INV = { id: 'v1', invoiceNumber: 'INV-D2-9', date: '2026-01-01', total: 100, outstanding: 100 };
  async function open(alloc: () => Response, payments: () => Response = () => ok([PAY])) {
    route((url, method) => {
      if (url.includes('/supplier-allocations') && method === 'POST') return alloc();
      if (url.includes('/supplier-payments')) return payments();
      if (url.includes('/supplier-invoices')) return ok([INV]);
      return ok([]);
    });
    render(<SupplierAllocationsPage />);
    fireEvent.click(await screen.findByText('PAY-D2-1'));
    fireEvent.click(await screen.findByRole('checkbox'));
    fireEvent.click(await screen.findByRole('button', { name: /Allocate/ }));
  }
  it('a refused allocation shows the server message, no success', async () => {
    await open(() => bad());
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.queryByText(/Allocated successfully/)).toBeNull();
  });
  it('an empty 500 allocation shows a plain sentence', async () => {
    await open(empty500);
    expect(await screen.findByText(/Could not allocate the payment - try again/)).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('allocation 200 then payments reload 500 keeps the success and clears the spinner', async () => {
    let gets = 0;
    await open(() => ok({}), () => { gets += 1; return gets === 1 ? ok([PAY]) : empty500(); });
    expect(await screen.findByText(/Allocated successfully/)).toBeTruthy();
    expect(await screen.findByText(/Could not load the unallocated payments - try again/)).toBeTruthy();
    await waitFor(() => expect(spinning()).toBe(false));
    expect(screen.queryByText('PAY-D2-1')).toBeNull();
  });
});
