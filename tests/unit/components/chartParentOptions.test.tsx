/**
 * W2-28 round 12: the Chart tab offered balance-sheet role holders (the bank
 * 1110, receivable 1120, payable 2110) as a parent for a new account, and the
 * server always refuses them. They are not offered; an income-statement holder
 * (revenue 4100) may take sub-accounts and stays.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), assertOk: vi.fn(), apiErrorMessage: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/accounting/AccountCategorySidebar', () => ({ AccountCategorySidebar: () => null, filterAccounts: (a: unknown[]) => a }));
vi.mock('@/components/accounting/dashboard/CoaSeedEmptyState', () => ({ CoaSeedEmptyState: () => null }));
vi.mock('@/components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
const codes = (options: { accountCode: string }[]) => options.map((o) => o.accountCode).join(',');
vi.mock('@/components/accounting/dashboard/AccountRow', () => ({
  AccountRow: ({ account, parentOptions }: { account: { accountCode: string }; parentOptions: { accountCode: string }[] }) => (
    <tr><td data-testid={`row-parents-${account.accountCode}`}>{codes(parentOptions)}</td></tr>),
}));
vi.mock('@/components/accounting/dashboard/AddAccountForm', () => ({
  AddAccountForm: ({ parentOptions }: { parentOptions: { accountCode: string }[] }) => <div data-testid="form-parents">{codes(parentOptions)}</div>,
}));

import { apiFetch } from '@/lib/apiFetch';
import { ChartOfAccountsTab } from '@/components/accounting/dashboard/ChartOfAccountsTab';

const acct = (accountCode: string, accountType: string, accountSubtype: string | undefined, isSystemAccount: boolean, isActive = true) =>
  ({ id: accountCode, accountCode, accountName: accountCode, accountType, accountSubtype, isSystemAccount, isActive });
const ACCOUNTS = [
  acct('1000', 'asset', undefined, true),            // a seeded header: system, but holds no role
  acct('1110', 'asset', 'bank', true), acct('1111', 'asset', 'bank', false),
  acct('1120', 'asset', 'receivable', true), acct('2110', 'liability', 'payable', true),
  acct('3200', 'equity', 'retained_earnings', true),
  acct('4100', 'revenue', 'default_revenue', true), acct('5100', 'expense', 'default_expense', true),
  acct('6000', 'expense', 'operating_expense', false, false),
];

afterEach(() => { cleanup(); });

it('offers every active account as a parent except the balance-sheet role holders — in the add form and in each row', async () => {
  vi.mocked(apiFetch).mockImplementation(async () => new Response(JSON.stringify({ success: true, data: ACCOUNTS }), { status: 200 }));
  render(<ChartOfAccountsTab />);
  fireEvent.click(await screen.findByRole('button', { name: /add account/i }));
  expect(screen.getByTestId('form-parents').textContent).toBe('1000,1111,4100,5100');
  expect(screen.getByTestId('row-parents-1111').textContent).toBe('1000,1111,4100,5100');
});
