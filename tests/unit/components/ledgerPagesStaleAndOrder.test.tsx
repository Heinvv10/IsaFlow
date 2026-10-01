// On the four pages that read the changed ledger endpoints: only the LATEST request may set state (for
// success and for error), and on an error nothing stale stays rendered. The REAL apiFetch/apiJson run over a
// stubbed fetch whose ledger responses are resolved by the test, out of order.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, pathname: '/x', push: vi.fn() }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));

import { AccountDrillDown } from '@/components/accounting/AccountDrillDown';
import GeneralLedgerPage from '../../../pages/accounting/reports/general-ledger';
import AccountTransactionsPage from '../../../pages/accounting/reports/account-transactions';
import AccountDetailPage from '../../../pages/accounting/reports/account-detail/[accountId]';

const LEDGER = /reports-(account-transactions|account-ledger|general-ledger)/;
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const bad = (message: string) => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message } }), { status: 400 });

type Pending = { resolve: (r: Response) => void };
function stubFetch(): Pending[] {
  const pending: Pending[] = [];
  vi.stubGlobal('fetch', vi.fn((url: unknown) =>
    LEDGER.test(String(url)) ? new Promise<Response>(resolve => pending.push({ resolve })) : Promise.resolve(ok({ items: [], accounts: [] }))));
  return pending;
}
const settle = async (p: Pending, r: Response) => { await act(async () => { p.resolve(r); await Promise.resolve(); }); };
const calls = (pending: Pending[], n: number) => waitFor(() => expect(pending.length).toBe(n));
afterEach(() => { vi.unstubAllGlobals(); router.query = {}; });

// ── Account Transactions ────────────────────────────────────────────────────
const txReport = (name: string) => ({ accountCode: '1110', accountName: name, accountType: 'expense', openingBalance: 1, periodNet: 0, closingBalance: 1, transactions: [] });

describe('Account Transactions page', () => {
  async function setup() {
    const pending = stubFetch();
    const view = render(<AccountTransactionsPage />);
    await calls(pending, 1);
    await settle(pending[0]!, ok(txReport('Name-A')));
    await screen.findByText(/Name-A/);
    const to = view.container.querySelectorAll('input[type=date]')[1]!;
    return { pending, to };
  }

  it('a slower earlier success cannot overwrite the latest', async () => {
    const { pending, to } = await setup();
    fireEvent.change(to, { target: { value: '2026-05-01' } }); await calls(pending, 2);
    fireEvent.change(to, { target: { value: '2026-06-01' } }); await calls(pending, 3);
    await settle(pending[2]!, ok(txReport('Name-LATEST')));
    await screen.findByText(/Name-LATEST/);
    await settle(pending[1]!, ok(txReport('Name-STALE')));
    expect(screen.queryByText(/Name-STALE/)).toBeNull();
    expect(screen.getByText(/Name-LATEST/)).toBeTruthy();
  }, 15000);

  it('a slower earlier ERROR cannot replace the latest result with an error', async () => {
    const { pending, to } = await setup();
    fireEvent.change(to, { target: { value: '2026-05-01' } }); await calls(pending, 2);
    fireEvent.change(to, { target: { value: '2026-06-01' } }); await calls(pending, 3);
    await settle(pending[2]!, ok(txReport('Name-LATEST')));
    await screen.findByText(/Name-LATEST/);
    await settle(pending[1]!, bad('stale failure'));
    expect(screen.queryByText('stale failure')).toBeNull();
    expect(screen.getByText(/Name-LATEST/)).toBeTruthy();
  }, 15000);

  it('after an error the previous report is gone and the message shows', async () => {
    const { pending, to } = await setup();
    fireEvent.change(to, { target: { value: '2026-05-01' } }); await calls(pending, 2);
    await settle(pending[1]!, bad('period_start must not be after period_end'));
    await screen.findByText('period_start must not be after period_end');
    expect(screen.queryByText(/Name-A/)).toBeNull();
  }, 15000);
});

// ── General Ledger ──────────────────────────────────────────────────────────
const glData = (name: string) => ({ accounts: [{ accountCode: '4000', accountName: name, accountType: 'revenue', openingBalance: 0, closingBalance: 1, totalDebit: 0, totalCredit: 1, transactions: [] }] });

describe('General Ledger page', () => {
  async function setup() {
    const pending = stubFetch();
    const view = render(<GeneralLedgerPage />);
    await calls(pending, 1);
    await settle(pending[0]!, ok(glData('Acc-A')));
    await screen.findByText('Acc-A');
    return { pending, to: view.container.querySelectorAll('input[type=date]')[1]! };
  }

  it('a slower earlier success cannot overwrite the latest', async () => {
    const { pending, to } = await setup();
    fireEvent.change(to, { target: { value: '2026-05-01' } }); await calls(pending, 2);
    fireEvent.change(to, { target: { value: '2026-06-01' } }); await calls(pending, 3);
    await settle(pending[2]!, ok(glData('Acc-LATEST')));
    await screen.findByText('Acc-LATEST');
    await settle(pending[1]!, ok(glData('Acc-STALE')));
    expect(screen.queryByText('Acc-STALE')).toBeNull();
    expect(screen.getByText('Acc-LATEST')).toBeTruthy();
  }, 15000);

  it('a slower earlier ERROR cannot replace the latest result with an error', async () => {
    const { pending, to } = await setup();
    fireEvent.change(to, { target: { value: '2026-05-01' } }); await calls(pending, 2);
    fireEvent.change(to, { target: { value: '2026-06-01' } }); await calls(pending, 3);
    await settle(pending[2]!, ok(glData('Acc-LATEST')));
    await screen.findByText('Acc-LATEST');
    await settle(pending[1]!, bad('stale failure'));
    expect(screen.queryByText('stale failure')).toBeNull();
    expect(screen.getByText('Acc-LATEST')).toBeTruthy();
  }, 15000);

  it('after an error the previous accounts are gone and the message shows', async () => {
    const { pending, to } = await setup();
    fireEvent.change(to, { target: { value: '2026-05-01' } }); await calls(pending, 2);
    await settle(pending[1]!, bad('period_start must not be after period_end'));
    await screen.findByText(/period_start must not be after period_end/);
    expect(screen.queryByText('Acc-A')).toBeNull();
  }, 15000);
});

// ── AccountDrillDown ────────────────────────────────────────────────────────
const drill = (desc: string) => ({
  accountCode: 'x', accountName: 'x', openingBalance: 0, periodNet: 1, closingBalance: 1,
  transactions: [{ date: '2026-04-01', entryNumber: 'JE', description: desc, debit: 1, credit: 0, balance: 1, source: 'manual' }],
});

describe('AccountDrillDown', () => {
  const props = { periodStart: '2026-01-01', periodEnd: '2026-09-30' };
  it('only the latest request sets state (success and error), and an error leaves nothing stale', async () => {
    const pending = stubFetch();
    const view = render(<AccountDrillDown accountCode="A" {...props} />);
    await calls(pending, 1);
    view.rerender(<AccountDrillDown accountCode="B" {...props} />); await calls(pending, 2);
    view.rerender(<AccountDrillDown accountCode="C" {...props} />); await calls(pending, 3);
    await settle(pending[2]!, ok(drill('tx-LATEST')));
    await screen.findByText('tx-LATEST');
    await settle(pending[1]!, ok(drill('tx-STALE')));
    await settle(pending[0]!, bad('stale failure'));
    expect(screen.queryByText('tx-STALE')).toBeNull();
    expect(screen.queryByText('stale failure')).toBeNull();
    view.rerender(<AccountDrillDown accountCode="D" {...props} />); await calls(pending, 4);
    await settle(pending[3]!, bad('Account not found'));
    await screen.findByText('Account not found');
    expect(screen.queryByText('tx-LATEST')).toBeNull();
  }, 15000);
});

// ── Account Detail ──────────────────────────────────────────────────────────
const detail = (desc: string) => ({
  rows: [{ journalEntryId: desc, entryDate: '2026-04-01', entryNumber: 'JE', description: desc, reference: '', source: 'manual', debit: 1, credit: 0, runningBalance: 1 }],
  total: 1, derivedRows: 0, openingBalance: 0, periodNet: 1, closedToRetainedEarnings: 0, periodClosingBalance: 1,
  meta: { accountId: 'a', accountCode: '5000', accountName: 'Exp', accountType: 'expense', normalBalance: 'debit' },
});

describe('Account Detail page', () => {
  it('only the latest request sets state, and an error leaves nothing stale', async () => {
    const pending = stubFetch();
    router.query = { accountId: '5000', from: '2026-01-01', to: '2026-03-31' };
    const view = render(<AccountDetailPage />);
    await calls(pending, 1);
    router.query = { accountId: '5000', from: '2026-01-01', to: '2026-04-30' };
    view.rerender(<AccountDetailPage />); await calls(pending, 2);
    router.query = { accountId: '5000', from: '2026-01-01', to: '2026-05-31' };
    view.rerender(<AccountDetailPage />); await calls(pending, 3);
    await settle(pending[2]!, ok(detail('row-LATEST')));
    await screen.findByText('row-LATEST');
    await settle(pending[1]!, ok(detail('row-STALE')));
    await settle(pending[0]!, bad('stale failure'));
    expect(screen.queryByText('row-STALE')).toBeNull();
    expect(screen.queryByText('stale failure')).toBeNull();
    router.query = { accountId: '5000', from: '2026-1-5', to: '2026-05-31' };
    view.rerender(<AccountDetailPage />); await calls(pending, 4);
    await settle(pending[3]!, bad('from must be a real date'));
    await screen.findByText(/from must be a real date/);
    expect(screen.queryByText('row-LATEST')).toBeNull();
  }, 15000);
});

// ── loading flag, cleared inputs, empty state ───────────────────────────────
const dateInputs = (c: HTMLElement) => c.querySelectorAll('input[type=date]');
const spinner = (c: HTMLElement) => c.querySelector('.animate-spin');

describe('loading flag belongs to the newest request', () => {
  it.each([
    ['General Ledger', () => <GeneralLedgerPage />, glData('Acc-X')],
    ['Account Transactions', () => <AccountTransactionsPage />, txReport('Name-X')],
  ])('%s: an older request finishing late leaves loading on until the newest finishes', async (_n, Page, data) => {
    const pending = stubFetch();
    const view = render(Page());
    await calls(pending, 1);
    fireEvent.change(dateInputs(view.container)[1]!, { target: { value: '2026-05-01' } }); await calls(pending, 2);
    await settle(pending[0]!, ok(data));
    expect(spinner(view.container)).not.toBeNull();
    await settle(pending[1]!, ok(data));
    await waitFor(() => expect(spinner(view.container)).toBeNull());
  }, 15000);

  it('Account Detail: same', async () => {
    const pending = stubFetch();
    router.query = { accountId: '5000', from: '2026-01-01', to: '2026-03-31' };
    const view = render(<AccountDetailPage />); await calls(pending, 1);
    router.query = { accountId: '5000', from: '2026-01-01', to: '2026-04-30' };
    view.rerender(<AccountDetailPage />); await calls(pending, 2);
    await settle(pending[0]!, ok(detail('row-OLD')));
    expect(spinner(view.container)).not.toBeNull();
    await settle(pending[1]!, ok(detail('row-NEW')));
    await screen.findByText('row-NEW');
  }, 15000);
});

describe('clearing an input invalidates in-flight requests and clears data and loading', () => {
  it.each([
    ['General Ledger', () => <GeneralLedgerPage />, glData('Acc-X'), 'Acc-X'],
    ['Account Transactions', () => <AccountTransactionsPage />, txReport('Name-X'), 'Name-X'],
  ])('%s', async (_n, Page, data, text) => {
    const pending = stubFetch();
    const view = render(Page());
    await calls(pending, 1);
    fireEvent.change(dateInputs(view.container)[1]!, { target: { value: '' } });
    await waitFor(() => expect(spinner(view.container)).toBeNull());
    await settle(pending[0]!, ok(data));
    expect(screen.queryByText(new RegExp(text))).toBeNull();
  }, 15000);

  it('General Ledger: after a successful load, clearing a date shows no "No account activity" text', async () => {
    const pending = stubFetch();
    const view = render(<GeneralLedgerPage />);
    await calls(pending, 1);
    await settle(pending[0]!, ok({ accounts: [] }));
    await screen.findByText('No account activity for the selected period');
    fireEvent.change(dateInputs(view.container)[1]!, { target: { value: '' } });
    await waitFor(() => expect(screen.queryByText('No account activity for the selected period')).toBeNull());
  }, 15000);

  it('Account Detail: no stuck spinner, late response ignored', async () => {
    const pending = stubFetch();
    router.query = { accountId: '5000', from: '2026-01-01', to: '2026-03-31' };
    const view = render(<AccountDetailPage />); await calls(pending, 1);
    router.query = { accountId: '5000', from: '', to: '2026-03-31' };
    view.rerender(<AccountDetailPage />);
    await waitFor(() => expect(spinner(view.container)).toBeNull());
    await settle(pending[0]!, ok(detail('row-LATE')));
    expect(screen.queryByText('row-LATE')).toBeNull();
  }, 15000);
});

describe('General Ledger empty state', () => {
  it('is shown only when the load succeeded with no rows, never beside an error', async () => {
    const pending = stubFetch();
    const view = render(<GeneralLedgerPage />);
    await calls(pending, 1);
    await settle(pending[0]!, ok({ accounts: [] }));
    await screen.findByText('No account activity for the selected period');
    fireEvent.change(dateInputs(view.container)[1]!, { target: { value: '2026-05-01' } }); await calls(pending, 2);
    await settle(pending[1]!, bad('period_start must not be after period_end'));
    await screen.findByText(/period_start must not be after period_end/);
    expect(screen.queryByText('No account activity for the selected period')).toBeNull();
  }, 15000);
});
