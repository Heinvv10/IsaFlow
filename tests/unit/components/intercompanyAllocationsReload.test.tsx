// Bills > Intercompany, "Payments from your group" (P4-C, review round 3): after a reload, no dialog or drawer stays on a row that is no
// longer listed (a 409 that empties the list, or one that takes one row away); a failed first load of a filter reports no payments; an
// action finished after a tab switch reloads the CURRENT tab; a rand payment against a foreign invoice shows each in its own currency.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/accounting/supplier-invoices/intercompany' }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyInboxPage from '../../../pages/accounting/supplier-invoices/intercompany';
import { formatAmount } from '@/lib/money/formatMoney';
import { formatCurrency } from '@/utils/formatters';
import { envelope, failure } from './intercompanyFixtures';
import { alloc, detailOf, serve } from './intercompanyInboxFixtures';
import type { AllocationItem } from '@/modules/accounting/services/intercompany/allocationInboxTypes';

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const section = () => screen.findByRole('region', { name: 'Payments from your group' });
const inv = (number: string) => ({ ...alloc().issuerInvoice!, id: `inv-${number}`, number });
const page = (items: AllocationItem[]) => envelope({ items, total: items.length, allocationCount: items.length });
const ROW_A = alloc({ id: 'a-1' });
const ROW_B = alloc({ id: 'a-2', issuerInvoice: inv('INV-901') });

/** The page with `first` listed; every later load of the open tab answers `then`; every POST answers a 409. */
function scripted(first: AllocationItem[], then: AllocationItem[]) {
  serve({ items: [], allocations: first });
  const real = vi.mocked(apiFetch).getMockImplementation()!;
  let loads = 0;
  vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
    if ((init as RequestInit | undefined)?.method === 'POST') return failure('This message was handled by someone else.', 409);
    if (String(url).includes('/allocations?filter=open')) return page(loads++ === 0 ? first : then);
    return real(url as never, init as never);
  });
}

describe('no dialog or drawer outlives its row', () => {
  it('a reject refused with a 409 whose reload empties the list closes the dialog and says why; it does not come back with the next list', async () => {
    scripted([ROW_A], []);
    render(<IntercompanyInboxPage />);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Reject payment SP-00012 on INV-900' }));
    fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: 'Not ours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject message' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('handled by someone else');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByRole('region', { name: 'Payments from your group' })).toBeNull();
    // the payments come back (another reload): the old dialog does not
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => (String(url).includes('/allocations?') ? page([ROW_A]) : envelope({ items: [], total: 0, openCount: 0 })));
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    fireEvent.click(screen.getByRole('button', { name: /Needs you/ }));
    await section();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a 409 whose reload takes one row away closes that row\'s drawer and dialogs, and leaves the other row usable', async () => {
    scripted([ROW_A, ROW_B], [ROW_B]);
    render(<IntercompanyInboxPage />);
    const s = await section();
    fireEvent.click(within(s).getByRole('button', { name: 'Reject payment SP-00012 on INV-900' }));
    fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: 'Not ours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject message' }));
    await waitFor(() => expect(within(s).getAllByTestId('allocation-row')).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByRole('alert')).toHaveTextContent('handled by someone else');
    expect(within(s).queryByRole('button', { name: /on INV-900/ })).toBeNull();
    expect(within(s).getByRole('button', { name: 'Reject payment SP-00012 on INV-901' })).toBeEnabled();
  });

  it('an open drawer on a row a reload removes is closed (never a title of a raw id)', async () => {
    serve({ items: [], allocations: [ROW_A, ROW_B], allocationDetail: detailOf(ROW_A) });
    const real = vi.mocked(apiFetch).getMockImplementation()!;
    render(<IntercompanyInboxPage />);
    const s = await section();
    fireEvent.click(within(s).getByRole('button', { name: 'Details for payment SP-00012 on INV-900' }));
    expect(await screen.findByRole('dialog', { name: 'Details for payment SP-00012 on INV-900' })).toBeInTheDocument();
    // the list reloads (a tab switch and back) without A
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if ((init as RequestInit | undefined)?.method === 'POST') return envelope({});
      if (String(url).includes('/allocations?')) return page([ROW_B]);
      return real(url as never, init as never);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    fireEvent.click(screen.getByRole('button', { name: /Needs you/ }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.queryByText(/a-1/)).toBeNull();
  });
});

describe('the payment count and the current tab', () => {
  it('a failed first load of a tab reports no payments: the empty invoice list says nothing is there', async () => {
    serve({ items: [], allocations: [alloc()] });
    const real = vi.mocked(apiFetch).getMockImplementation()!;
    render(<IntercompanyInboxPage />);
    await screen.findByText('No invoices or credit notes waiting');
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) =>
      (String(url).includes('/allocations?filter=handled') ? failure('Down', 500) : real(url as never, init as never)));
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    await screen.findByText(/Payments from your group: Down/);
    expect(await screen.findByText('Nothing handled yet')).toBeInTheDocument();
  });

  it('an action finished after a tab switch reloads the tab now shown, never the one it started on', async () => {
    let release: (r: Response) => void = () => undefined;
    serve({ items: [], allocations: [alloc()] });
    const real = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if ((init as RequestInit | undefined)?.method === 'POST') return new Promise<Response>((r) => { release = r; });
      if (String(url).includes('/allocations?filter=handled')) return page([alloc({ id: 'h-1', paymentNumber: 'SP-HANDLED', status: 'rejected', live: false, liveReason: 'not_pending' })]);
      return real(url as never, init as never);
    });
    render(<IntercompanyInboxPage />);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Dismiss payment SP-00012 on INV-900' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss payment' }));
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    await within(await section()).findByText('SP-HANDLED');
    const before = vi.mocked(apiFetch).mock.calls.length;
    await act(async () => { release(envelope({})); });
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.length).toBeGreaterThan(before));
    const after = vi.mocked(apiFetch).mock.calls.slice(before).map(([u]) => String(u)).filter((u) => u.includes('/allocations?'));
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((u) => u.includes('filter=handled'))).toBe(true);
    expect(within(await section()).getByText('SP-HANDLED')).toBeInTheDocument();
  });
});

describe('a rand payment against a foreign invoice', () => {
  it('shows the currency mismatch, the payment in rand and the open amount in euro, in the row and the drawer', async () => {
    const item = alloc({ mismatch: 'currency', issuerInvoice: { ...inv('INV-900'), currency: 'EUR', openAmount: 2000 } });
    serve({ items: [], allocations: [item], allocationDetail: detailOf(item) });
    render(<IntercompanyInboxPage />);
    const row = within(await section()).getByTestId('allocation-row');
    expect(within(row).getByTestId('allocation-state')).toHaveTextContent('Check: not in rand, or not in the invoice\'s currency');
    expect(row.textContent).toContain(formatCurrency(1150));
    expect(row.textContent).toContain(`EUR ${formatAmount(2000)}`);
    fireEvent.click(within(row).getByRole('button', { name: 'Details for payment SP-00012 on INV-900' }));
    const drawer = await screen.findByRole('dialog');
    await within(drawer).findByText('SP-00012');
    expect(drawer.textContent).toContain(formatCurrency(1150));
    expect(drawer.textContent).toContain(`EUR ${formatAmount(2000)}`);
  });
});
