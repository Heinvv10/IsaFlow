/**
 * D2 round 3 (a5): ar-aging and bank-accounts. A 400 envelope shows the server's message, an empty-body 500
 * a plain sentence (never JSON / "Failed ..." text), a 200 renders; a failing reload clears the old rows;
 * bank-account writes show the server's reason and never claim success.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/AgingInvoicesPanel', () => ({ AgingInvoicesPanel: () => null }));
vi.mock('@/components/accounting/banking/BankEmptyState', () => ({ BankEmptyState: () => <p>no bank accounts yet</p> }));
vi.mock('@/components/accounting/bank/BankAccountCard', () => ({
  BankAccountCard: ({ acct, onEdit }: { acct: { accountName: string }; onEdit: (a: unknown) => void }) => (
    <div><span>{acct.accountName}</span><button onClick={() => onEdit(acct)}>edit card</button></div>
  ),
}));
vi.mock('@/components/accounting/bank/BankAccountModals', () => ({
  buildParentCandidates: () => [],
  EditBankAccountModal: ({ onSave }: { onSave: () => void }) => <button onClick={onSave}>edit save</button>,
  AddBankAccountModal: ({ setForm, onSave }: { setForm: (f: unknown) => void; onSave: () => void }) => (
    <div>
      <button onClick={() => setForm({ accountCode: '1190', accountName: 'Nedbank', description: '', bankAccountNumber: '', parentAccountId: '' })}>fill bank</button>
      <button onClick={onSave}>bank save</button>
    </div>
  ),
}));

import { notify } from '@/utils/toast';
import ARAgingPage from '../../../pages/accounting/ar-aging/index';
import BankAccountsPage from '../../../pages/accounting/bank-accounts/index';
import { typeDate } from '../helpers/dateFields';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(notify.error).mockClear(); vi.mocked(notify.success).mockClear(); });

const BUCKET = { entityId: 'c1', entityName: 'D2 Debtor Ltd', current: 10, days30: 0, days60: 0, days90: 0, days120Plus: 0, total: 10 };
const ACCT = { id: 'a1', accountCode: '1100', accountName: 'D2 Cheque', accountType: 'asset', isActive: true, txnCount: 0, totalDebits: 0, totalCredits: 0, balance: 0 };

describe('ar-aging', () => {
  const only = (fn: () => Response) => (u: string) => (u.includes('ar-aging?') ? fn() : undefined);
  it('400: the server message from the envelope', async () => {
    script(only(refuse));
    render(<ARAgingPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('empty-body 500: a plain sentence, not a parse error or bare Failed', async () => {
    script(only(empty500));
    render(<ARAgingPage />);
    expect(await screen.findByText('Could not load AR aging - try again')).toBeTruthy();
    expectNoRawError();
  });
  it('200: the rows render', async () => {
    script(only(() => ok([BUCKET])));
    render(<ARAgingPage />);
    expect(await screen.findByText('D2 Debtor Ltd')).toBeTruthy();
  });
  it('load OK, change the as-at date, reload 500: the old rows are gone', async () => {
    script(u => (u.includes('as_at_date=2025-03-01') ? empty500() : u.includes('ar-aging?') ? ok([BUCKET]) : undefined));
    const { container } = render(<ARAgingPage />);
    await screen.findByText('D2 Debtor Ltd');
    typeDate(container.querySelector('input[placeholder="dd MMM yyyy"]')!, '2025-03-01');
    expect(await screen.findByText('Could not load AR aging - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 Debtor Ltd')).toBeNull());
    expectNoRawError();
  });
});

describe('bank-accounts', () => {
  const api = (write: (u: string, m: string) => Response | undefined, reload?: () => Response) => (u: string, m: string) => {
    if (m !== 'GET') return write(u, m);
    if (u.includes('next-code')) return ok({ code: '' });
    return reload ? reload() : ok([ACCT]);
  };
  it('load 400: the server message', async () => {
    script(api(() => undefined, refuse));
    render(<BankAccountsPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('load empty-body 500: a plain sentence', async () => {
    script(api(() => undefined, empty500));
    render(<BankAccountsPage />);
    expect(await screen.findByText('Could not load bank accounts - try again')).toBeTruthy();
    expectNoRawError();
  });
  it('load 200: the account renders', async () => {
    script(api(() => undefined));
    render(<BankAccountsPage />);
    expect(await screen.findByText('D2 Cheque')).toBeTruthy();
  });

  const add = async () => {
    render(<BankAccountsPage />);
    await screen.findByText('D2 Cheque');
    fireEvent.click(screen.getByRole('button', { name: /add bank account/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'fill bank' }));
    fireEvent.click(screen.getByRole('button', { name: 'bank save' }));
  };
  const edit = async () => {
    render(<BankAccountsPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'edit card' }));
    fireEvent.click(await screen.findByRole('button', { name: 'edit save' }));
  };

  it('add refused: the server message is notified, no success', async () => {
    script(api(refuse));
    await add();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
    expect(notify.success).not.toHaveBeenCalled();
  });
  it('add with an empty-body 500: a plain sentence is notified', async () => {
    script(api(empty500));
    await add();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not create the bank account - try again'));
    expect(notify.success).not.toHaveBeenCalled();
  });
  it('edit: the account update refused shows the server message', async () => {
    script(api(refuse));
    await edit();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith(MSG));
    expect(notify.success).not.toHaveBeenCalled();
  });
  it('edit: the account update answered by an empty-body 500 shows a plain sentence', async () => {
    script(api(empty500));
    await edit();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not update the account - try again'));
  });
  it('edit: the bank-number update answered by an empty-body 500 shows a plain sentence', async () => {
    script(api(u => (u.includes('/bank-accounts') ? empty500() : ok({}))));
    await edit();
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not update the bank account - try again'));
    expect(notify.success).not.toHaveBeenCalled();
  });
  it('edit 200 then reload 500: success is notified, the reload error shows, the old card is gone', async () => {
    let done = false;
    script(api(() => { done = true; return ok({}); }, () => (done ? empty500() : ok([ACCT]))));
    await edit();
    await waitFor(() => expect(notify.success).toHaveBeenCalledWith('Bank account updated'));
    expect(await screen.findByText('Could not load bank accounts - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Cheque')).toBeNull();
    expect(document.querySelector('.animate-spin')).toBeNull();
  });
});
