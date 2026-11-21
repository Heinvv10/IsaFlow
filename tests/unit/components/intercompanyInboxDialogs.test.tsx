// Bills > Intercompany inbox: the list and its dialogs keep to the message in front of them (an emptied page, a filter switch, a stale
// answer, the reject dialog between messages, a credit note's one account).
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
import { envelope } from './intercompanyFixtures';
import { detail, item, posts, serve } from './intercompanyInboxFixtures';

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the list and its dialogs keep to the message in front of them', () => {
  it('a page that has become empty (its last row was handled) goes back to the first page instead of stranding', async () => {
    const offsets: number[] = [];
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      const u = String(url);
      const offset = Number(/offset=(\d+)/.exec(u)?.[1] ?? 0);
      if (u.includes('/inbox?')) {
        offsets.push(offset);
        return envelope({ items: offset === 0 ? [item({ number: 'INV-FIRST' })] : [], total: 30, openCount: 30 });
      }
      return envelope({});
    });
    render(<IntercompanyInboxPage />);
    await screen.findByText('INV-FIRST');
    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(offsets).toContain(25));
    // the page at offset 25 came back empty: the page asks for offset 0 again and shows its rows
    await waitFor(() => expect(offsets.slice(-1)[0]).toBe(0));
    expect(await screen.findByText('INV-FIRST')).toBeInTheDocument();
    expect(screen.queryByText('Nothing waiting for you')).toBeNull();
  });

  it('switching the filter clears the list at once (no flash of the other list), and a slow answer to the earlier filter never replaces the newer one', async () => {
    let releaseOpen: (r: Response) => void = () => undefined;
    let first = true;
    vi.mocked(apiFetch).mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (!u.includes('/inbox?')) return envelope({});
      if (u.includes('filter=open') && first) { first = false; return envelope({ items: [item({ number: 'INV-OPEN' })], total: 1, openCount: 1 }); }
      if (u.includes('filter=open')) return new Promise<Response>((r) => { releaseOpen = r; });
      return envelope({ items: [item({ id: 'h', number: 'INV-HANDLED', status: 'accepted' })], total: 1, openCount: 1 });
    });
    render(<IntercompanyInboxPage />);
    await screen.findByText('INV-OPEN');
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    expect(screen.queryByText('INV-OPEN')).toBeNull(); // cleared at once
    await screen.findByText('INV-HANDLED');
    // now a slow, stale answer for the OPEN filter arrives late: it must not replace the handled list
    fireEvent.click(screen.getByRole('button', { name: /Needs you/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Handled' }));
    await screen.findByText('INV-HANDLED');
    releaseOpen(envelope({ items: [item({ number: 'INV-STALE' })], total: 1, openCount: 1 }));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.queryByText('INV-STALE')).toBeNull();
    expect(screen.getByText('INV-HANDLED')).toBeInTheDocument();
  });

  it('the reject dialog starts empty for each message: one message\'s reason (and error) is never carried to the next', async () => {
    serve({ items: [item({ id: 'm-1', number: 'INV-1' }), item({ id: 'm-2', number: 'INV-2' })] });
    render(<IntercompanyInboxPage />);
    const rows = await screen.findAllByTestId('inbox-row');
    fireEvent.click(within(rows[0]!).getByRole('button', { name: 'Reject' }));
    fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: 'meant for another company' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByLabelText(/Reason/)).toBeNull());
    fireEvent.click(within(screen.getAllByTestId('inbox-row')[1]!).getByRole('button', { name: 'Reject' }));
    expect((await screen.findByLabelText(/Reason/)) as HTMLTextAreaElement).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: 'Reject message' }));
    expect(await screen.findByText(/Say why you are rejecting it/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(screen.getAllByTestId('inbox-row')[0]!).getByRole('button', { name: 'Reject' }));
    await screen.findByLabelText(/Reason/);
    expect(screen.queryByText(/Say why you are rejecting it/)).toBeNull(); // the error did not travel either
  });

  it('a credit note has ONE account select (its payload is one line, and one account is what is sent)', async () => {
    const note = item({ kind: 'credit_note', number: 'CN-7', total: 230 });
    const oneLine = detail({ item: note, lines: [{ index: 0, description: 'Returned router', quantity: 1, unitPrice: 200, taxRate: 15, taxAmount: 30, lineTotal: 200, accountId: 'acc-1', accountLabel: '5000 Fees', accountSource: 'default' }] });
    // even a (hand-made) detail with two lines shows one select
    const twoLines = detail({ item: note, lines: [...oneLine.lines, { ...oneLine.lines[0]!, index: 1, description: 'Second' }] });
    serve({ items: [note], detail: twoLines, post: () => envelope({ messageId: 'm-1', targetDocType: 'credit_note', targetDocId: 'cn-1', linkId: 'l', pdfCopied: false }) });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByText('Draft goes on supplier');
    expect(screen.getAllByRole('combobox')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Accept as draft' }));
    await screen.findByText(/Accepted CN-7 as a draft/);
    expect(JSON.parse(String((posts()[0]![1] as RequestInit).body))).toEqual({ accountId: 'acc-1' });
    expect(screen.getByRole('link', { name: 'Open the draft' })).toHaveAttribute('href', '/accounting/supplier-credit-notes/cn-1');
  });

  it('every suggested account is in the dialog\'s list (the list the server sends holds it)', async () => {
    serve({ detail: detail({ accounts: [{ id: 'acc-1', label: '5000 Fees' }, { id: 'acc-2', label: '5100 Consumables' }] }) });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    const select = (await screen.findByLabelText('Account for line 1')) as HTMLSelectElement;
    expect(select.value).toBe('acc-1');
    expect([...select.options].map((o) => o.value)).toContain('acc-1');
  });
});

describe('a double submit sends one request', () => {
  /** A POST held open, so the first submit is still in flight when the second arrives. */
  const slowPost = () => { let release: (r: Response) => void = () => undefined; const held = new Promise<Response>((r) => { release = r; }); return { held, release }; };

  it('Accept: two clicks in the same event batch (before React re-renders the disabled button) post once', async () => {
    const slow = slowPost();
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      const u = String(url);
      if ((init as RequestInit | undefined)?.method === 'POST') return slow.held;
      if (u.includes('/inbox?')) return envelope({ items: [item()], total: 1, openCount: 1 });
      return envelope(detail());
    });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    await screen.findByText('Draft goes on supplier');
    fireEvent.change(screen.getByLabelText('Account for line 2'), { target: { value: 'acc-2' } });
    const accept = screen.getByRole('button', { name: 'Accept as draft' });
    act(() => { fireEvent.click(accept); fireEvent.click(accept); });
    expect(posts()).toHaveLength(1);
    await act(async () => { slow.release(envelope({ messageId: 'm-1', targetDocType: 'supplier_invoice', targetDocId: 'bill-1', linkId: 'l-1', pdfCopied: true })); });
    await screen.findByText(/Accepted INV-100 as a draft/);
    expect(posts()).toHaveLength(1);
  });

  it('Reject: two submits in the same event batch post once', async () => {
    const slow = slowPost();
    vi.mocked(apiFetch).mockImplementation(async (url: unknown, init?: unknown) => {
      if ((init as RequestInit | undefined)?.method === 'POST') return slow.held;
      return String(url).includes('/inbox?') ? envelope({ items: [item()], total: 1, openCount: 1 }) : envelope(detail());
    });
    render(<IntercompanyInboxPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Reject' }));
    fireEvent.change(await screen.findByLabelText(/Reason/), { target: { value: 'Not ours' } });
    const submit = screen.getByRole('button', { name: 'Reject message' });
    act(() => { fireEvent.click(submit); fireEvent.click(submit); });
    expect(posts()).toHaveLength(1);
    await act(async () => { slow.release(envelope({})); });
    await screen.findByText(/Rejected INV-100/);
    expect(posts()).toHaveLength(1);
  });
});

