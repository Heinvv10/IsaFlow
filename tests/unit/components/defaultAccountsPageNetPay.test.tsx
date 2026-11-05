/**
 * The Default Accounts "Payroll net pay" row: where a pay run credits net pay.
 * Its empty option is a real choice (the bank, today's behaviour), not "Not
 * configured"; it offers only what the save accepts (a leaf, active liability on
 * the payroll_liability subtype that the payroll journal does not already credit:
 * not a tax, payable or no-subtype account);
 * choosing one sends `payroll_net_pay` with the holder the page loaded.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import DefaultAccountsPage from '@/../pages/accounting/default-accounts';
import { apiFetch } from '@/lib/apiFetch';

vi.mock('@/lib/apiFetch', async () => ({ ...(await vi.importActual<typeof import('@/lib/apiFetch')>('@/lib/apiFetch')), apiFetch: vi.fn() }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const acct = (id: string, accountType: string, accountSubtype: string | undefined, extra: Record<string, unknown> = {}) =>
  ({ id, accountCode: id, accountName: `Account ${id}`, accountType, accountSubtype, isActive: true, isSystemAccount: false, ...extra });
const ACCOUNTS = [
  acct('1110', 'asset', 'bank', { isSystemAccount: true }),
  acct('2110', 'liability', 'payable', { isSystemAccount: true }),
  acct('2140', 'liability', 'payroll_liability'),
  acct('2170', 'liability', 'payroll_liability'),
  acct('2171', 'liability', 'payroll_liability', { isActive: false }),
  acct('2200', 'liability', undefined, { level: 1 }),
  acct('2210', 'liability', 'payroll_liability', { parentAccountId: '2200' }),
  acct('2125', 'liability', 'tax'),
  acct('2300', 'liability', undefined),
];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

afterEach(() => { cleanup(); });

const load = (mappings: Record<string, string | null> = {}) => vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
  if (String(url).startsWith('/api/accounting/chart-of-accounts')) return json({ data: ACCOUNTS });
  if (init?.method === 'POST') return json({ data: { saved: true } });
  return json({ data: { mappings } });
});

it('shows a Payroll row whose empty option names the bank, and offers only acceptable liabilities', async () => {
  load();
  render(<DefaultAccountsPage />);
  const select = await screen.findByRole('combobox', { name: 'Payroll net pay' });
  const options = within(select).getAllByRole('option') as HTMLOptionElement[];
  expect(options[0]).toMatchObject({ value: '' });
  expect(options[0]!.textContent).toBe('Bank account (pays salaries directly)');
  expect(options.map((o) => o.value).filter(Boolean)).toEqual(['2170', '2210']);
  expect(screen.getByRole('heading', { name: 'Payroll' })).toBeTruthy();
  // Every other row still says "Not configured".
  expect(within(screen.getByRole('combobox', { name: 'Petty Cash' })).getAllByRole('option')[0]!.textContent).toBe('Not configured');
});

it('keeps the account the setting names selected, and saves a change with the loaded value', async () => {
  load({ payroll_net_pay: '2170' });
  render(<DefaultAccountsPage />);
  const select = await screen.findByRole('combobox', { name: 'Payroll net pay' }) as HTMLSelectElement;
  expect(select.value).toBe('2170');

  fireEvent.change(select, { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: /Save Changes/ }));
  await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true));
  const post = vi.mocked(apiFetch).mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(JSON.parse(String(post[1]!.body))).toEqual({ mappings: { payroll_net_pay: '' }, loaded: { payroll_net_pay: '2170' } });
});
