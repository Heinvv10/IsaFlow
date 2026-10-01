/**
 * W2-28 round 11: the chart's refusals reach the person who triggered them.
 * These callers read `json.message`, but the API envelope is
 * `{ success: false, error: { message } }`, so every refusal — "holds the bank
 * role…", "would give the role two holders" — was shown as "Failed to update
 * account". Each test answers with the REAL envelope and expects its message.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mockedApiFetchModule, useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/AccountCategorySidebar', () => ({ AccountCategorySidebar: () => null, filterAccounts: (a: unknown[]) => a }));
vi.mock('@/components/accounting/dashboard/CoaSeedEmptyState', () => ({ CoaSeedEmptyState: () => null }));
vi.mock('@/components/accounting/dashboard/AccountRow', () => ({
  AccountRow: ({ account, onUpdate, onDelete }: { account: { id: string }; onUpdate: (id: string, d: unknown) => void; onDelete: (id: string) => void }) => (
    <tr><td>
      <button onClick={() => onUpdate(account.id, { accountName: 'n', description: '', defaultVatCode: '', vatInputDenied: false, parentAccountId: 'bank' })}>row save</button>
      <button onClick={() => onDelete(account.id)}>row delete</button>
    </td></tr>
  ),
}));
vi.mock('@/components/accounting/dashboard/AddAccountForm', () => ({
  AddAccountForm: ({ onChange, onSubmit }: { onChange: (f: unknown) => void; onSubmit: () => void }) => (
    <div>
      <button onClick={() => onChange({ accountCode: '1119', accountName: 'Sub', accountType: 'asset', accountSubtype: '', parentAccountId: 'bank', description: '' })}>fill</button>
      <button onClick={onSubmit}>form save</button>
    </div>
  ),
}));
vi.mock('@/components/ui/ConfirmDialog', () => ({
  ConfirmDialog: ({ open, onAccept }: { open: boolean; onAccept: () => void }) => (open ? <button onClick={onAccept}>confirm</button> : null),
}));
vi.mock('@/components/accounting/bank/BankAccountModals', () => ({
  buildParentCandidates: () => [],
  EditBankAccountModal: () => null,
  AddBankAccountModal: ({ setForm, onSave }: { setForm: (f: unknown) => void; onSave: () => void }) => (
    <div>
      <button onClick={() => setForm({ accountCode: '1190', accountName: 'Nedbank', description: '', bankAccountNumber: '123', parentAccountId: '' })}>fill bank</button>
      <button onClick={onSave}>bank save</button>
    </div>
  ),
}));
vi.mock('@/components/accounting/bank/BankAccountCard', () => ({ BankAccountCard: () => null }));
vi.mock('@/components/accounting/banking/BankEmptyState', () => ({ BankEmptyState: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { notify } from '@/utils/toast';
import { ChartOfAccountsTab } from '@/components/accounting/dashboard/ChartOfAccountsTab';
import BankAccountsPage from '../../../pages/accounting/bank-accounts/index';

void mockedApiFetchModule;
useApiJsonOverMock();

const REFUSAL = 'Account 1110 holds the bank role, and a balance-sheet account that holds a system role cannot have sub-accounts';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const refused = () => json({ success: false, error: { code: 'BAD_REQUEST', message: REFUSAL } }, 400);
const ACCOUNT = { id: 'a1', accountCode: '1115', accountName: 'Savings', accountType: 'asset', isActive: true };

/** GETs succeed; the write with `method` to a URL containing `path` is refused with the real envelope. */
function answer(path: string, method: string) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes(path) && (init?.method ?? 'GET') === method) return refused();
    if (u.includes('next-code')) return json({ success: true, data: { code: '' } });
    if ((init?.method ?? 'GET') === 'GET') return json({ success: true, data: u.includes('bank-accounts') ? [] : [ACCOUNT] });
    return json({ success: true, data: { id: 'new-1' } });
  });
}

afterEach(() => { cleanup(); vi.mocked(notify.error).mockClear(); });

it('chart tab: a refused create shows the server\'s reason', async () => {
  answer('/api/accounting/chart-of-accounts', 'POST');
  render(<ChartOfAccountsTab />);
  fireEvent.click(await screen.findByRole('button', { name: /add account/i }));
  fireEvent.click(screen.getByRole('button', { name: 'fill' }));
  fireEvent.click(screen.getByRole('button', { name: 'form save' }));
  await waitFor(() => expect(notify.error).toHaveBeenCalledWith(REFUSAL));
});

it('chart tab: a refused update shows the server\'s reason', async () => {
  answer('/api/accounting/chart-of-accounts', 'PUT');
  render(<ChartOfAccountsTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'row save' }));
  await waitFor(() => expect(notify.error).toHaveBeenCalledWith(REFUSAL));
});

it('chart tab: a refused deactivation shows the server\'s reason', async () => {
  answer('/api/accounting/chart-of-accounts-detail', 'DELETE');
  render(<ChartOfAccountsTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'row delete' }));
  fireEvent.click(await screen.findByRole('button', { name: 'confirm' }));
  await waitFor(() => expect(notify.error).toHaveBeenCalledWith(REFUSAL));
});

it('chart tab: a failure with no server message keeps the plain fallback', async () => {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => (
    init?.method === 'PUT' ? new Response('<html>502</html>', { status: 502 }) : json({ success: true, data: [ACCOUNT] })));
  render(<ChartOfAccountsTab />);
  fireEvent.click(await screen.findByRole('button', { name: 'row save' }));
  await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Failed to update account'));
});

it('bank accounts page: when the new account\'s bank number is refused, it says so instead of "Bank account created"', async () => {
  answer('/api/accounting/bank-accounts', 'PUT');
  render(<BankAccountsPage />);
  fireEvent.click(await screen.findByRole('button', { name: /add bank account/i }));
  fireEvent.click(await screen.findByRole('button', { name: 'fill bank' }));
  fireEvent.click(screen.getByRole('button', { name: 'bank save' }));
  await waitFor(() => expect(notify.error).toHaveBeenCalledWith(expect.stringContaining(REFUSAL)));
  expect(notify.success).not.toHaveBeenCalled();
});
