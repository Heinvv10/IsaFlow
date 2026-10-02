/**
 * D2 round 3 (a3): bank-reconciliation detail + list. A 400 shows
 * the server's message, an empty-body 500 a plain sentence (never "Unmatch failed" / "Network error" / a JSON
 * parse error), a 200 takes effect; a failed reload clears the old rows; a write that succeeded is still reported.
 */
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

const push = vi.fn();
const q: { current: Record<string, string> } = { current: { reconId: 'r-1' } };
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: q.current, push, replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/ConfirmDialog', () => ({ ConfirmDialog: ({ open, onConfirm }: { open: boolean; onConfirm: () => void }) => (open ? <button onClick={onConfirm}>CONFIRM-CANCEL</button> : null) }));

import { apiFetch } from '@/lib/apiFetch';
import ReconDetailPage from '../../../pages/accounting/bank-reconciliation/[reconId]';
import ReconListPage from '../../../pages/accounting/bank-reconciliation/index';
import { MSG, bad, boom, expectNoRawJsonError, ok } from '../helpers/d2CensusG4';
import { trio3 } from '../helpers/d2R3a3';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.unstubAllGlobals(); });

const isGet = (init?: RequestInit) => !init?.method || init.method === 'GET';
const clickBtn = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));
const RECON = (diff: number) => ({ id: 'r-1', bankAccountId: 'b1', bankAccountName: 'D2 Cheque', statementDate: '2031-03-01', statementBalance: 10, glBalance: 10, reconciledBalance: 10,
  difference: diff, status: 'in_progress', startedBy: 'u', startedAt: '2031-03-01', createdAt: '2031-03-01', updatedAt: '2031-03-01' });
const TX = (id: string, status: string) => ({ id, bankAccountId: 'b1', transactionDate: '2031-03-01', amount: 10, description: `D2 line ${id}`, status, feedState: 'posted' });
const reconOthers = (diff: number, txs: unknown[], skip: (u: string, i?: RequestInit) => boolean) => (u: string, i?: RequestInit) => {
  if (skip(u, i)) return undefined;
  if (u.includes('bank-reconciliations?id=')) return ok(RECON(diff));
  if (u.includes('bank-transactions?reconciliation_id=')) return ok({ transactions: txs });
  if (u.includes('journal-entries?')) return ok({ entries: [] });
  return undefined;
};
const post = (path: string) => (u: string, i?: RequestInit) => u.includes(path) && i?.method === 'POST';
const isPost = (u: string, i?: RequestInit) => post('-action')(u, i);

describe('bank-reconciliation detail actions', () => {
  const open = () => { q.current = { reconId: 'r-1' }; return render(<ReconDetailPage />); };
  const unm = [TX('t1', 'imported')];
  const mat = [TX('t2', 'matched')];
  trio3({ name: 'auto-match', render: open, drive: async () => { await clickBtn(/auto-match/i); }, match: post('bank-transactions-action'), data: { matched: 3 },
    others: reconOthers(5, unm, isPost), plain: 'Could not auto-match - try again', succeeds: async () => { expect(await screen.findByText(/Auto-matched 3/)).toBeTruthy(); } });
  trio3({ name: 'exclude', render: open, drive: async () => { fireEvent.click(await screen.findByTitle('Exclude')); }, match: post('bank-transactions-action'), data: {},
    others: reconOthers(5, unm, isPost), plain: 'Could not exclude - try again', succeeds: async () => { expect(await screen.findByText('Transaction excluded')).toBeTruthy(); },
    stays: () => { expect(screen.queryByText('Transaction excluded')).toBeNull(); } });
  trio3({ name: 'unmatch', render: open, drive: async () => { fireEvent.click(await screen.findByTitle('Unmatch')); }, match: post('bank-transactions-action'), data: {},
    others: reconOthers(5, mat, isPost), plain: 'Could not unmatch - try again', succeeds: async () => { expect(await screen.findByText('Transaction unmatched')).toBeTruthy(); },
    stays: () => { expect(screen.queryByText('Transaction unmatched')).toBeNull(); } });
  trio3({ name: 'complete', render: open, drive: async () => { await clickBtn(/complete reconciliation/i); }, match: post('bank-reconciliations-action'), data: {},
    others: reconOthers(0, mat, isPost), plain: 'Could not complete the reconciliation - try again', succeeds: async () => { expect(await screen.findByText('Reconciliation completed')).toBeTruthy(); },
    stays: () => { expect(screen.queryByText('Reconciliation completed')).toBeNull(); } });
  trio3({ name: 'cancel', render: open, drive: async () => { await clickBtn(/^cancel reconciliation$/i); await clickBtn(/confirm-cancel/i); },
    match: post('bank-reconciliations-action'), data: {}, others: reconOthers(5, unm, isPost), plain: 'Could not cancel the reconciliation - try again',
    succeeds: async () => { await vi.waitFor(() => expect(push).toHaveBeenCalledWith('/accounting/bank-reconciliation')); }, stays: () => { expect(push).not.toHaveBeenCalled(); } });

  it('write succeeds but the reload fails: the old rows are cleared, the error and the success are both shown', async () => {
    let loads = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (isPost(u, init)) return ok({});
      if (u.includes('bank-reconciliations?id=')) return ++loads === 1 ? ok(RECON(5)) : boom();
      return reconOthers(5, mat, () => false)(u, init) ?? ok({});
    });
    open();
    fireEvent.click(await screen.findByTitle('Unmatch'));
    expect(await screen.findByText('Could not load the reconciliation - try again')).toBeTruthy();
    expect(screen.getByText('Transaction unmatched')).toBeTruthy();
    expect(screen.queryByText('D2 line t2')).toBeNull(); expect(screen.queryByTitle('Unmatch')).toBeNull();
    expectNoRawJsonError();
  });
});

describe('bank-reconciliation list', () => {
  const LIST = [{ ...RECON(0), matchedCount: 1, unmatchedCount: 0 }];
  it('a failed reload clears the rows and shows the server message', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => (++gets === 1 ? ok(LIST) : bad()));
    render(<ReconListPage />);
    await screen.findByText('D2 Cheque');
    fireEvent.click(await screen.findByLabelText(/cancel reconciliation for D2 Cheque/i));
    await clickBtn(/confirm-cancel/i);
    expect((await screen.findAllByText(MSG)).length).toBeGreaterThan(0);
  });
  it('a good cancel followed by a failing reload clears the row and shows the error', async () => {
    let gets = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown, init?: RequestInit) => {
      if (isPost(String(url), init)) return ok({});
      return ++gets === 1 ? ok(LIST) : boom();
    });
    render(<ReconListPage />);
    await screen.findByText('D2 Cheque');
    fireEvent.click(await screen.findByLabelText(/cancel reconciliation for D2 Cheque/i));
    await clickBtn(/confirm-cancel/i);
    expect(await screen.findByText('Could not load the reconciliations - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Cheque')).toBeNull(); expectNoRawJsonError();
  });
  const drive = async () => { fireEvent.click(await screen.findByLabelText(/cancel reconciliation for D2 Cheque/i)); await clickBtn(/confirm-cancel/i); };
  trio3({ name: 'list cancel', render: () => render(<ReconListPage />), drive, match: post('bank-reconciliations-action'), data: {},
    others: (u, i) => (isGet(i) ? ok(LIST) : undefined), plain: 'Could not cancel the reconciliation - try again',
    succeeds: async () => { await vi.waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(c => isGet(c[1] as RequestInit | undefined)).length).toBeGreaterThan(1)); },
    stays: () => { expect(vi.mocked(apiFetch).mock.calls.filter(c => isGet(c[1] as RequestInit | undefined)).length).toBe(1); } });
});
