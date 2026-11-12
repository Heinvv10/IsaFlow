// #1285 follow-up: Statement Imports lists the company's paired browser-extension connections
// (from GET /api/accounting/bank-feeds, which is company-scoped) and revokes one, after a
// confirmation, through DELETE /api/accounting/bank-feeds/[id], the soft-delete that makes
// extension-ingest refuse its token (tests/integration/bank-feed-extension-revoke.int.test.ts).
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', async (original) => ({ ...await original<typeof import('@/lib/apiFetch')>(), apiFetch: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { apiFetch } from '@/lib/apiFetch';
import { PairedExtensionsPanel } from '@/components/accounting/bank/PairedExtensionsPanel';

const LIST = '/api/accounting/bank-feeds';

const conn = (over: Record<string, unknown>) => ({
  id: 'c1', companyId: 'co', provider: 'extension', accountId: 'gl1', accountName: 'Business Cheque',
  accountNumberMasked: null, externalAccountId: '4051234567', status: 'active',
  lastSyncAt: 'Tue Nov 10 2026 09:15:00 GMT+0200 (South Africa Standard Time)', lastSuccessAt: null,
  lastSyncStatus: 'success', lastSyncError: null, lastSync: null, config: { bankId: 'absa' },
  createdAt: 'Sun Nov 01 2026 08:00:00 GMT+0200 (South Africa Standard Time)', updatedAt: 'x', ...over,
});

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const fail = (status: number, message: string) =>
  new Response(JSON.stringify({ success: false, error: { message } }), { status });

/** Answer the list GET with `items` (then `after` once a DELETE has run), and DELETE with `del`. */
function serve(items: unknown[], opts: { after?: unknown[]; del?: () => Response } = {}) {
  let deleted = false;
  vi.mocked(apiFetch).mockImplementation(async (url, init) => {
    if (init?.method === 'DELETE') { deleted = true; return (opts.del ?? (() => ok({ deleted: true })))(); }
    if (url === LIST) { const list = deleted && opts.after ? opts.after : items; return ok({ items: list, count: list.length }); }
    throw new Error(`unexpected ${String(url)}`);
  });
}

const deletes = () => vi.mocked(apiFetch).mock.calls.filter(([, init]) => init?.method === 'DELETE');

beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('PairedExtensionsPanel', () => {
  it('lists only browser-extension connections, with account, paired date, last import and status', async () => {
    serve([conn({}), conn({ id: 'csv', provider: 'manual_csv', accountName: 'CSV only account' })]);
    render(<PairedExtensionsPanel />);
    const row = await screen.findByRole('row', { name: /Business Cheque/ });
    expect(within(row).getByText(/4567/)).toBeTruthy();
    expect(within(row).queryByText(/4051234567/)).toBeNull();
    expect(within(row).getByText('01 Nov 2026')).toBeTruthy();
    expect(within(row).getByText(/10 Nov 2026/)).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
    expect(screen.queryByText('CSV only account')).toBeNull();
    expect(apiFetch).toHaveBeenCalledWith(LIST);
  });

  it('says when an extension has never imported and when its last import failed', async () => {
    serve([conn({ lastSyncAt: null, lastSyncStatus: null }),
      conn({ id: 'c2', accountName: 'Savings', lastSyncStatus: 'failed', lastSyncError: 'Daily limit reached' })]);
    render(<PairedExtensionsPanel />);
    expect(within(await screen.findByRole('row', { name: /Business Cheque/ })).getByText('Never')).toBeTruthy();
    expect(within(screen.getByRole('row', { name: /Savings/ })).getByText('Last import failed')).toBeTruthy();
  });

  it.each([
    ['no extension connections', () => serve([conn({ provider: 'manual_csv' })])],
    ['a 403 for a read-only member', () => vi.mocked(apiFetch).mockResolvedValue(fail(403, 'Forbidden: write access required'))],
  ])('renders nothing for %s', async (_n, arrange) => {
    arrange();
    const { container } = render(<PairedExtensionsPanel />);
    await vi.waitFor(() => expect(apiFetch).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(container.innerHTML).toBe('');
  });

  it('shows a plain sentence when the list cannot load', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response('', { status: 502 }));
    render(<PairedExtensionsPanel />);
    expect(await screen.findByText('Could not load the paired browser extensions - try again')).toBeTruthy();
  });

  it('asks before revoking, and Keep sends nothing', async () => {
    serve([conn({})]);
    render(<PairedExtensionsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Business Cheque' }));
    expect(screen.getByText(/stop sending transactions/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(screen.queryByText(/stop sending transactions/)).toBeNull();
    expect(deletes()).toHaveLength(0);
  });

  it('a confirmed revoke DELETEs that connection, then reloads the list without it', async () => {
    serve([conn({}), conn({ id: 'c2', accountName: 'Savings' })], { after: [conn({ id: 'c2', accountName: 'Savings' })] });
    render(<PairedExtensionsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Business Cheque' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    // End state (R-150): the notice shows AND the reloaded list has dropped the revoked row AND the dialog closed.
    await vi.waitFor(() => {
      expect(screen.getByText('Revoked. That browser extension can no longer send transactions.')).toBeTruthy();
      expect(screen.queryByRole('row', { name: /Business Cheque/ })).toBeNull();
      expect(screen.queryByText(/stop sending transactions/)).toBeNull();
    });
    expect(deletes()).toEqual([['/api/accounting/bank-feeds/c1', { method: 'DELETE' }]]);
    expect(screen.getByRole('row', { name: /Savings/ })).toBeTruthy();
  });

  it("a refused revoke shows the server's message and keeps the row", async () => {
    serve([conn({})], { del: () => fail(403, 'Forbidden: write access required') });
    render(<PairedExtensionsPanel />);
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke Business Cheque' }));
    fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText('Forbidden: write access required')).toBeTruthy();
    expect(screen.getByRole('row', { name: /Business Cheque/ })).toBeTruthy();
  });
});
