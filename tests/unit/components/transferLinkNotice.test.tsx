// The Bank Transactions notice for automatic transfer links (migration 978): what it says, who may undo, and what
// Undo / Dismiss / Review do. apiFetch is mocked (no relative fetch reaches a real server).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({ role: 'manager' as string | null }));
vi.mock('@/lib/apiFetch', async (orig) => ({ ...(await orig<typeof import('@/lib/apiFetch')>()), apiFetch: vi.fn() }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: h.role }) }));
vi.mock('@/utils/toast', () => ({ notify: { success: vi.fn(), warning: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { TransferLinkNotice } from '@/components/accounting/bank-transactions/TransferLinkNotice';
import type { TransferLinkBatch } from '@/modules/accounting/services/bank/bankTransferLinkLog';

const BANK = 'bank-1';
const now = new Date().toISOString();
const link = (id: string, undoneAt: string | null = null) => ({
  id, bankTransactionId: `t-${id}`, transactionDate: '2026-11-10', description: `Transfer ${id}`, amount: 100,
  counterpartyAccountName: 'Savings', state: (undoneAt ? 'undone' : 'linked') as 'undone' | 'linked', undoneAt,
});
const batch = (batchId: string, links: ReturnType<typeof link>[], linkedAt = now): TransferLinkBatch => ({
  batchId, source: 'page_load', linkedAt, activeCount: links.filter((l) => !l.undoneAt).length, links,
});
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code: 'CONFLICT', message } }), { status });

let batches: TransferLinkBatch[] = [];
let postReply: () => Response = () => ok({ undone: 1, refused: 0 });

function mount(onChanged = vi.fn()) {
  render(<TransferLinkNotice bankAccountId={BANK} refreshKey={0} onChanged={onChanged} />);
  return onChanged;
}
const posts = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST');

beforeEach(() => {
  h.role = 'manager';
  window.localStorage.clear();
  batches = [];
  postReply = () => ok({ undone: 1, refused: 0 });
  vi.mocked(notify.success).mockReset();
  vi.mocked(notify.warning).mockReset();
  vi.mocked(notify.error).mockReset();
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_url: string, init?: RequestInit) =>
    (init?.method === 'POST' ? postReply() : ok({ batches })));
});

describe('TransferLinkNotice', () => {
  it('renders nothing when the account has no automatic links', async () => {
    const { container } = render(<TransferLinkNotice bankAccountId={BANK} refreshKey={0} onChanged={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  it('counts the live links across recent batches, singular and plural', async () => {
    batches = [batch('b1', [link('a'), link('b')]), batch('b2', [link('c'), link('d', now)])];
    mount();
    expect(await screen.findByText('3 transfers linked automatically.')).toBeInTheDocument();
    expect(screen.getByText(/IsaFlow matched imported statement lines/)).toBeInTheDocument();
  });

  it('uses the singular for one link and leaves out batches older than 7 days', async () => {
    batches = [batch('b1', [link('a')]), batch('old', [link('z')], '2020-01-01T00:00:00.000Z')];
    mount();
    expect(await screen.findByText('1 transfer linked automatically.')).toBeInTheDocument();
  });

  it('Dismiss hides the notice, remembers the batches, and keeps the log link', async () => {
    batches = [batch('b1', [link('a')])];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Transfer link log' })).toBeInTheDocument();
    expect(JSON.parse(window.localStorage.getItem(`isaflow.bankTx.transferLinkNotice.dismissed.${BANK}`) ?? '[]')).toEqual(['b1']);
  });

  it('Review opens the log drawer', async () => {
    batches = [batch('b1', [link('a')])];
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Review' }));
    expect(await screen.findByRole('dialog', { name: 'Transfer link log' })).toBeInTheDocument();
  });

  it('Undo posts once per notice batch, then reloads and tells the page', async () => {
    batches = [batch('b1', [link('a')]), batch('b2', [link('b')])];
    const onChanged = mount();
    const undo = await screen.findByRole('button', { name: 'Undo' });
    await waitFor(() => expect(undo).toBeEnabled());
    fireEvent.click(undo);
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(posts().map(([, init]) => JSON.parse(String((init as RequestInit).body)))).toEqual([
      { action: 'undo', batchId: 'b1' }, { action: 'undo', batchId: 'b2' },
    ]);
    expect(notify.success).toHaveBeenCalledWith('2 transfer links undone');
    // Loaded on mount, and again after the undo.
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([, i]) => !(i as RequestInit)?.method).length).toBe(2));
  });

  it('warns when some lines were refused', async () => {
    batches = [batch('b1', [link('a'), link('b')])];
    postReply = () => ok({ undone: 1, refused: 1 });
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(notify.warning).toHaveBeenCalledWith('1 undone, 1 not undone',
      'Those lines have changed since they were linked. Open each line to change it.'));
  });

  it('shows the server sentence on a 409 and does not tell the page anything changed', async () => {
    batches = [batch('b1', [link('a')])];
    postReply = () => fail(409, 'These lines have changed since they were linked, so nothing was undone.');
    const onChanged = mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('These lines have changed since they were linked, so nothing was undone.'));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('gives a viewer Review but no Undo', async () => {
    h.role = 'viewer';
    batches = [batch('b1', [link('a')])];
    mount();
    expect(await screen.findByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });

  it('shows an alert when the log cannot be loaded', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(fail(500, 'Internal'));
    mount();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
  });

  it('tolerates an empty or unmocked reply without throwing', async () => {
    vi.mocked(apiFetch).mockReset().mockResolvedValue(new Response('null', { status: 200 }));
    const { container } = render(<TransferLinkNotice bankAccountId={BANK} refreshKey={0} onChanged={vi.fn()} />);
    await waitFor(() => expect(apiFetch).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
