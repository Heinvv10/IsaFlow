// The server's specific 400/404 message must reach the user on every page that reads a changed ledger
// endpoint. The envelope is the real one: { success:false, error:{ code, message } }.
import { render, screen } from '@testing-library/react';
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

const envelope = (status: number, code: string, message: string) =>
  new Response(JSON.stringify({ success: false, error: { code, message } }), { status, headers: { 'content-type': 'application/json' } });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });

/** Every ledger endpoint answers with `failure`; reference-data endpoints answer empty. */
function serve(failure: Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
    const u = String(url);
    if (/reports-(account-transactions|account-ledger|general-ledger)/.test(u)) return failure.clone();
    return ok({ items: [], accounts: [] });
  }));
}
afterEach(() => { vi.unstubAllGlobals(); router.query = {}; });

describe('the server message reaches the user', () => {
  it('AccountDrillDown: 404 Account not found', async () => {
    serve(envelope(404, 'NOT_FOUND', 'Account not found'));
    render(<AccountDrillDown accountCode="9999" periodStart="2026-01-01" periodEnd="2026-09-30" />);
    expect(await screen.findByText('Account not found')).toBeTruthy();
  }, 10000);

  it('General Ledger page: 400 inverted range', async () => {
    serve(envelope(400, 'BAD_REQUEST', 'period_start must not be after period_end'));
    render(<GeneralLedgerPage />);
    expect(await screen.findByText(/period_start must not be after period_end/)).toBeTruthy();
  }, 10000);

  it('Account Transactions page: 400 bad date', async () => {
    serve(envelope(400, 'BAD_REQUEST', 'period_start and period_end must be real dates, YYYY-MM-DD'));
    render(<AccountTransactionsPage />);
    expect(await screen.findByText(/must be real dates, YYYY-MM-DD/)).toBeTruthy();
  }, 10000);

  it('Account Detail page: 400 bad date', async () => {
    router.query = { accountId: '5000', from: '2026-1-5', to: '2026-09-30' };
    serve(envelope(400, 'BAD_REQUEST', 'from must be a real date, YYYY-MM-DD'));
    render(<AccountDetailPage />);
    expect(await screen.findByText(/from must be a real date, YYYY-MM-DD/)).toBeTruthy();
  }, 10000);

  it('Account Detail page: 404 Account not found', async () => {
    router.query = { accountId: '5000', from: '2026-01-01', to: '2026-09-30' };
    serve(envelope(404, 'NOT_FOUND', 'Account not found'));
    render(<AccountDetailPage />);
    expect(await screen.findByText('Account not found')).toBeTruthy();
  }, 10000);
});
