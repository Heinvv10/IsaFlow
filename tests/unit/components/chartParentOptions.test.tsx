/**
 * W2-28 rounds 12-13: the Chart tab offered balance-sheet role holders (the
 * bank 1110, receivable 1120, payable 2110) as a parent, and the server always
 * refuses them. They are not offered; an income-statement holder (revenue
 * 4100) may take sub-accounts and stays. An account that is ALREADY under such
 * a holder (legacy data) still shows that parent, so the form tells the truth.
 * Real AddAccountForm and AccountRow: the options are what the user sees.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), assertOk: vi.fn(), apiErrorMessage: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/accounting/AccountCategorySidebar', () => ({ AccountCategorySidebar: () => null, filterAccounts: (a: unknown[]) => a }));
vi.mock('@/components/accounting/dashboard/CoaSeedEmptyState', () => ({ CoaSeedEmptyState: () => null }));
vi.mock('@/components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { ChartOfAccountsTab } from '@/components/accounting/dashboard/ChartOfAccountsTab';

const acct = (accountCode: string, accountType: string, accountSubtype: string | undefined, isSystemAccount: boolean, over: Record<string, unknown> = {}) =>
  ({ id: accountCode, accountCode, accountName: `Acct ${accountCode}`, accountType, accountSubtype, isSystemAccount, isActive: true,
    normalBalance: 'debit', level: 3, children: [], ...over });
const ACCOUNTS = [
  acct('1000', 'asset', undefined, true),            // a seeded header: system, but holds no role
  acct('1110', 'asset', 'bank', true), acct('1111', 'asset', 'bank', false),
  acct('1112', 'asset', 'bank', false, { parentAccountId: '1110' }),   // legacy: already under the bank holder
  acct('1120', 'asset', 'receivable', true), acct('2110', 'liability', 'payable', true),
  acct('4100', 'revenue', 'default_revenue', true), acct('4150', 'revenue', 'revenue', false),
  acct('6000', 'expense', 'operating_expense', false, { isActive: false }),
];
const optionCodes = (select: HTMLElement) => within(select).getAllByRole('option').map((o) => (o.textContent ?? '').split(' ')[0]).filter((c) => /^\d/.test(c));
const editRow = (code: string) => {
  const row = screen.getByText(`Acct ${code}`).closest('tr')!;
  fireEvent.click(within(row).getByTitle('Edit'));
  return within(row).getByTitle(/^Parent account\./) as HTMLSelectElement;
};
let put: Record<string, unknown> | null = null;

function load() {
  put = null;
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => {
    if (init?.method === 'PUT') put = JSON.parse(String(init.body));
    return new Response(JSON.stringify({ success: true, data: ACCOUNTS }), { status: 200 });
  });
  render(<ChartOfAccountsTab />);
}

afterEach(() => { cleanup(); });

it('the add form offers every active account as a parent except the balance-sheet role holders', async () => {
  load();
  fireEvent.click(await screen.findByRole('button', { name: /add account/i }));
  const select = screen.getByText('Parent Account').parentElement!.querySelector('select')!;
  expect(optionCodes(select)).toEqual(['1000', '1111', '1112', '4100', '4150']);
});

it('a row\'s parent picker leaves them out too (same type only), and keeps an income-statement holder', async () => {
  load();
  await screen.findByText('Acct 1111');
  expect(optionCodes(editRow('1111'))).toEqual(['1000', '1112']);
  expect(optionCodes(editRow('4150'))).toEqual(['4100']);
});

it('an account already under a balance-sheet holder shows that parent, marked, and an untouched save does not send a parent', async () => {
  load();
  await screen.findByText('Acct 1112');
  const select = editRow('1112');
  expect({ value: select.value, shown: select.selectedOptions[0]?.textContent, codes: optionCodes(select) }).toEqual({
    value: '1110', shown: '1110 - Acct 1110 (system account — cannot be chosen for other accounts)', codes: ['1000', '1110', '1111'] });
  fireEvent.click(within(select.closest('tr')!).getByTitle('Save'));
  await vi.waitFor(() => expect(put).not.toBeNull());
  expect(Object.keys(put!)).not.toContain('parentAccountId');
});
