// Bills > Intercompany, "Payments from your group" (P4-C, review round 2): every action and notice names its row by payment AND invoice
// (unique even for two rows of one payment, or a stale and a live message of the same pair); the reject dialog names both and says the
// rejection is final and recorded on the message; foreign amounts carry their currency; a mismatch shows on a stale row too; a failed reload
// keeps the list and the open dialog; a 409 reloads the list; busy is per row; the filter switch clears an old error.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const h = vi.hoisted(() => ({ role: 'owner' as string }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn(), query: {}, pathname: '/accounting/supplier-invoices/intercompany' }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import IntercompanyInboxPage from '../../../pages/accounting/supplier-invoices/intercompany';
import { envelope, failure } from './intercompanyFixtures';
import { alloc, posts, serve } from './intercompanyInboxFixtures';

beforeEach(() => { h.role = 'owner'; vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

const section = () => screen.findByRole('region', { name: 'Payments from your group' });
const inv = (number: string) => ({ ...alloc().issuerInvoice!, id: `inv-${number}`, number });
const allocationCalls = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('/allocations?'));

describe('rows are named by payment and invoice', () => {
  it('two rows of one payment side by side have their own buttons and notices', async () => {
    serve({ items: [], allocations: [alloc({ id: 'a-1', issuerInvoice: inv('INV-900') }), alloc({ id: 'a-2', issuerInvoice: inv('INV-901') })] });
    render(<IntercompanyInboxPage />);
    const s = await section();
    for (const verb of ['Details for', 'Reject', 'Dismiss']) {
      expect(within(s).getAllByRole('button', { name: `${verb} payment SP-00012 on INV-900` })).toHaveLength(1);
      expect(within(s).getAllByRole('button', { name: `${verb} payment SP-00012 on INV-901` })).toHaveLength(1);
    }
    fireEvent.click(within(s).getByRole('button', { name: 'Dismiss payment SP-00012 on INV-901' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss payment' }));
    await screen.findByText(/Dismissed payment SP-00012 on INV-901/);
    expect(posts().map(([u]) => String(u))).toEqual(['/api/accounting/intercompany/allocations/a-2/dismiss']);
  });

  it('a stale and a live message of the same payment and invoice are told apart (1 of 2, 2 of 2)', async () => {
    serve({ items: [], allocations: [alloc({ id: 'a-1', live: false, liveReason: 'allocation_gone' }), alloc({ id: 'a-2' })] });
    render(<IntercompanyInboxPage />);
    const s = await section();
    expect(within(s).getByRole('button', { name: 'Reject payment SP-00012 on INV-900 (1 of 2)' })).toBeInTheDocument();
    expect(within(s).getByRole('button', { name: 'Reject payment SP-00012 on INV-900 (2 of 2)' })).toBeInTheDocument();
  });

  it('a row with no invoice of yours is named by the payer\'s bill', async () => {
    serve({ items: [], allocations: [alloc({ issuerInvoice: null, mismatch: 'invoice_gone' })] });
    render(<IntercompanyInboxPage />);
    expect(within(await section()).getByRole('button', { name: 'Reject payment SP-00012 on bill BILL-7' })).toBeInTheDocument();
  });

  it('the reject dialog names the payment and the invoice, says the rejection is final and recorded on the message, and never that the payer will read it', async () => {
    serve({ items: [], allocations: [alloc()] });
    render(<IntercompanyInboxPage />);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Reject payment SP-00012 on INV-900' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Reject payment SP-00012 on INV-900');
    expect(dialog).toHaveTextContent(/final/i);
    expect(dialog).toHaveTextContent(/recorded on the message/i);
    expect(dialog.textContent).not.toMatch(/will (see|read)|goes back to/i);
    fireEvent.change(screen.getByLabelText(/Reason/), { target: { value: 'Not ours' } });
    fireEvent.click(screen.getByRole('button', { name: 'Reject message' }));
    const done = await screen.findByText(/Rejected payment SP-00012 on INV-900/);
    expect(done.textContent).not.toMatch(/will see/);
  });
});

describe('what a row shows', () => {
  it('a foreign amount and open amount carry their currency code; rand stays rand', async () => {
    serve({ items: [], allocations: [alloc({ currency: 'USD', mismatch: 'currency', issuerInvoice: { ...inv('INV-900'), currency: 'USD', openAmount: 2000 } })] });
    render(<IntercompanyInboxPage />);
    const row = within(await section()).getByTestId('allocation-row');
    expect(row.textContent).toContain('USD 1 150.00');
    expect(row.textContent).toContain('USD 2 000.00');
    expect(row.textContent).not.toMatch(/R\s1 150\.00/);
  });

  it('a mismatch shows on a stale row too, beside its stale reason', async () => {
    serve({ items: [], allocations: [alloc({ currency: 'USD', live: false, liveReason: 'journal_reversed', mismatch: 'currency' })] });
    render(<IntercompanyInboxPage />);
    const row = within(await section()).getByTestId('allocation-row');
    expect(within(row).getByTestId('allocation-state')).toHaveTextContent('Stale: the payment journal was reversed');
    expect(within(row).getByTestId('allocation-mismatch')).toHaveTextContent('Check: not in rand');
  });

  it('before_cutover is worded as either case', async () => {
    serve({ items: [], allocations: [alloc({ live: false, liveReason: 'before_cutover' })] });
    render(<IntercompanyInboxPage />);
    expect(within(await section()).getByTestId('allocation-state')).toHaveTextContent('Stale: no cut-over set or the payment is dated before it');
  });
});

describe('reloads and busy state', () => {
  it('a reject refused with a 409 reloads the list; a failed reload keeps the list, the open dialog and its error, with the alert above', async () => {
    serve({ items: [], allocations: [alloc(), alloc({ id: 'a-2', issuerInvoice: inv('INV-901') })] });
    const real = vi.mocked(apiFetch).getMockImplementation()!;
    render(<IntercompanyInboxPage />);
    const s = await section();
    fireEvent.click(within(s).getByRole('button', { name: 'Reject payment SP-00012 on INV-900' }));
    fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: 'Not ours' } });
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if ((init as RequestInit | undefined)?.method === 'POST') return failure('This message cannot be changed now.', 409);
      if (String(url).includes('/allocations?')) return failure('Down', 500);
      return real(url as never, init as never);
    });
    const before = allocationCalls().length;
    fireEvent.click(screen.getByRole('button', { name: 'Reject message' }));
    expect(await screen.findByText(/Payments from your group: Down/)).toBeInTheDocument();
    expect(allocationCalls().length).toBeGreaterThan(before);
    expect(screen.getByRole('dialog')).toHaveTextContent('This message cannot be changed now.');
    expect(within(await section()).getAllByTestId('allocation-row')).toHaveLength(2);
  });

  it('a 409 on dismiss says so and reloads the list', async () => {
    serve({ items: [], allocations: [alloc()], post: () => failure('This message was handled by someone else.', 409) });
    render(<IntercompanyInboxPage />);
    fireEvent.click(within(await section()).getByRole('button', { name: 'Dismiss payment SP-00012 on INV-900' }));
    const before = allocationCalls().length;
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss payment' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('handled by someone else');
    await waitFor(() => expect(allocationCalls().length).toBeGreaterThan(before));
  });

  it('busy is per row: while one dismiss is in flight, the other row\'s buttons stay enabled', async () => {
    let release: (r: Response) => void = () => undefined;
    serve({ items: [], allocations: [alloc(), alloc({ id: 'a-2', issuerInvoice: inv('INV-901') })] });
    const real = vi.mocked(apiFetch).getMockImplementation()!;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) =>
      ((init as RequestInit | undefined)?.method === 'POST' ? new Promise<Response>((r) => { release = r; }) : real(url as never, init as never)));
    render(<IntercompanyInboxPage />);
    const s = await section();
    fireEvent.click(within(s).getByRole('button', { name: 'Dismiss payment SP-00012 on INV-900' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss payment' }));
    await waitFor(() => expect(within(s).getByRole('button', { name: 'Reject payment SP-00012 on INV-900' })).toBeDisabled());
    expect(within(s).getByRole('button', { name: 'Reject payment SP-00012 on INV-901' })).toBeEnabled();
    expect(within(s).getByRole('button', { name: 'Dismiss payment SP-00012 on INV-901' })).toBeEnabled();
    await act(async () => { release(envelope({})); });
  });

  it('switching the filter clears an old load error', async () => {
    serve({ allocationsFail: true });
    render(<IntercompanyInboxPage />);
    await screen.findByText(/Payments from your group:/);
    const real = vi.mocked(apiFetch).getMockImplementation()!;
    let releaseHandled: (r: Response) => void = () => undefined;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) =>
      (String(url).includes('/allocations?filter=handled') ? new Promise<Response>((r) => { releaseHandled = r; }) : real(url as never, init as never)));
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    await waitFor(() => expect(screen.queryByText(/Payments from your group:/)).toBeNull());
    await act(async () => { releaseHandled(envelope({ items: [], total: 0, allocationCount: 0 })); });
  });

  it('the invoice list keeps the last payment count while the payments reload (no flash of "Nothing waiting")', async () => {
    serve({ items: [], allocations: [alloc()] });
    const real = vi.mocked(apiFetch).getMockImplementation()!;
    render(<IntercompanyInboxPage />);
    await section();
    await screen.findByText('No invoices or credit notes waiting');
    let release: (r: Response) => void = () => undefined;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) =>
      (String(url).includes('/allocations?filter=handled') ? new Promise<Response>((r) => { release = r; }) : real(url as never, init as never)));
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    expect(await screen.findByText('No invoices or credit notes handled yet')).toBeInTheDocument();
    expect(screen.queryByText('Nothing handled yet')).toBeNull();
    await act(async () => { release(envelope({ items: [], total: 0, allocationCount: 0 })); });
    expect(await screen.findByText('Nothing handled yet')).toBeInTheDocument();
  });
});
