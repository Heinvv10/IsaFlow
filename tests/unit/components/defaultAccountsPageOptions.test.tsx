/**
 * D5 round 2: each Default Accounts row offers the accounts the save would
 * accept for its role (`defaultAccountRoles.roleCandidates`, which asks the
 * save's own `roleTargetRefusal`): an income-statement role may go to a header,
 * a balance-sheet role may not; wrong type, inactive or another classification
 * is not offered. The holder shown stays in the list. A row with no role offers
 * every active account.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DefaultAccountsPage from '@/../pages/accounting/default-accounts';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const acct = (id: string, accountType: string, accountSubtype?: string, extra: Record<string, unknown> = {}) =>
  ({ id, accountCode: id, accountName: `Account ${id}`, accountType, accountSubtype, isActive: true, isSystemAccount: false, ...extra });
const ACCOUNTS = [
  acct('4000', 'revenue', 'other', { level: 1 }),                      // revenue header
  acct('4010', 'revenue', 'revenue', { parentAccountId: '4000' }),     // classified for another use
  acct('4100', 'revenue', 'default_revenue', { isSystemAccount: true }),
  acct('1000', 'asset', undefined, { level: 1 }),                      // asset header: its only child is inactive
  acct('1010', 'asset', undefined, { parentAccountId: '1000', isActive: false }),
  acct('1110', 'asset', 'bank', { isSystemAccount: true }),
  acct('1150', 'asset', 'inventory'),
  acct('1190', 'asset', 'other'),
];
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

const offered = async (label: string) => within(await screen.findByRole('combobox', { name: label }))
  .getAllByRole('option').map((o) => (o as HTMLOptionElement).value).filter(Boolean);

afterEach(() => { cleanup(); });

it('offers, per row, the accounts the save would accept for its role', async () => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => (String(url).startsWith('/api/accounting/chart-of-accounts')
    ? json({ data: ACCOUNTS })
    : json({ data: { mappings: { sales_revenue: '4100', primary_bank: '1110' } } })));
  render(<DefaultAccountsPage />);
  expect({
    salesRevenue: await offered('Sales Revenue'),
    primaryBank: await offered('Primary Bank Account'),
    pettyCash: await offered('Petty Cash'),
  }).toEqual({
    salesRevenue: ['4000', '4100'],                                    // the revenue header IS offered
    primaryBank: ['1110', '1190'],                                     // the asset header is not
    pettyCash: ['4000', '4010', '4100', '1000', '1110', '1150', '1190'],
  });
  // The chart is read with its inactive rows: an inactive child still makes its parent a header.
  expect(vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)))
    .toContain('/api/accounting/chart-of-accounts?includeInactive=true');
});
