/**
 * D2 round 3 (a7): depreciation run, bureau clients, financial-years (counts, actions, add year), adjustments empty
 * row, bank-accounts reload-in-finally, new-invoice missing id. A 400 shows the server's message, an empty-body 500
 * a plain sentence (never JSON / HTTP / bare Failed), a 200 takes effect.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const push = vi.hoisted(() => vi.fn());
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push, replace: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));
vi.mock('@/contexts/CompanyContext', () => { const activeCompany = { id: 'co-1' }; return { useCompany: () => ({ activeCompany, companies: [] }) }; });
vi.mock('@/components/accounting/bank/BankAccountCard', () => ({
  BankAccountCard: ({ acct, onEdit }: { acct: { accountName: string }; onEdit: (a: unknown) => void }) => (
    <div><span>{acct.accountName}</span><button onClick={() => onEdit(acct)}>edit card</button></div>
  ),
}));
vi.mock('@/components/accounting/bank/BankAccountModals', () => ({
  buildParentCandidates: () => [],
  EditBankAccountModal: ({ onSave }: { onSave: () => void }) => <button onClick={onSave}>edit save</button>,
  AddBankAccountModal: () => null,
}));
vi.mock('@/components/accounting/banking/BankEmptyState', () => ({ BankEmptyState: () => <p>no bank accounts yet</p> }));
vi.mock('@/components/accounting/financialYears/YearCard', () => ({
  YearCard: ({ group, jeCounts }: { group: { year: number }; jeCounts: Record<string, number> }) => <p>year {group.year} counts {JSON.stringify(jeCounts)}</p>,
}));
vi.mock('@/components/accounting/financialYears/AddYearModal', () => ({
  AddYearModal: ({ onConfirm }: { onConfirm: (y: number) => Promise<void> }) => (
    <button onClick={() => { void onConfirm(2099).catch((e: Error) => { document.body.setAttribute('data-add-error', e.message); document.body.setAttribute('data-add-error-class', e.name); }); }}>add year go</button>
  ),
}));
vi.mock('@/components/accounting/financialYears/CloseYearModal', () => ({ CloseYearModal: () => null }));

import { notify } from '@/utils/toast';
import DepreciationPage from '../../../pages/accounting/depreciation/index';
import BureauClientsPage from '../../../pages/bureau/clients/index';
import FinancialYearsPage from '../../../pages/accounting/financial-years/index';
import AdjustmentsPage from '../../../pages/accounting/adjustments/index';
import BankAccountsPage from '../../../pages/accounting/bank-accounts/index';
import NewInvoicePage from '../../../pages/accounting/customer-invoices/new';

useApiJsonOverMock();
afterEach(() => { cleanup(); push.mockClear(); vi.mocked(notify.error).mockClear(); vi.mocked(notify.success).mockClear(); document.body.removeAttribute('data-add-error'); document.body.removeAttribute('data-add-error-class'); });

const RUN = { processed: 1, skipped: 0, glFailed: 0, total: 1, results: [] };
const click = async (name: RegExp | string) => fireEvent.click(await screen.findByRole('button', { name }));

describe('depreciation: Run Monthly Depreciation', () => {
  const api = (run: () => Response, assets: () => Response = () => ok({ items: [] })) => (u: string, m: string) =>
    (m === 'POST' && u.includes('run-depreciation') ? run() : u.includes('/assets') ? assets() : undefined);
  it('400: the server message', async () => {
    script(api(refuse)); render(<DepreciationPage />);
    await click(/run monthly depreciation/i);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('Last Run Results')).toBeNull();
  });
  it('empty-body 500: a plain sentence, not a bare Failed', async () => {
    script(api(empty500)); render(<DepreciationPage />);
    await click(/run monthly depreciation/i);
    expect(await screen.findByText('Could not run depreciation - try again')).toBeTruthy();
    expectNoRawError();
  });
  it('200: the results render', async () => {
    script(api(() => ok(RUN))); render(<DepreciationPage />);
    await click(/run monthly depreciation/i);
    expect(await screen.findByText('Last Run Results')).toBeTruthy();
  });
  it('200 then the asset reload 500: the results stay, the reload error shows, nothing stays spinning', async () => {
    let ran = false;
    script(api(() => { ran = true; return ok(RUN); }, () => (ran ? empty500() : ok({ items: [] }))));
    render(<DepreciationPage />);
    await click(/run monthly depreciation/i);
    expect(await screen.findByText('Could not load the assets - try again')).toBeTruthy();
    expect(screen.getByText('Last Run Results')).toBeTruthy();
    expect((screen.getByRole('button', { name: /run monthly depreciation/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('bureau clients: a failed load is not "not a member of any bureau"', () => {
  it('400 on the bureau list: the server message replaces the empty-membership line', async () => {
    script(u => (u === '/api/bureau' ? refuse() : undefined)); render(<BureauClientsPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/aren.t a member of any bureau/)).toBeNull();
  });
  it('empty-body 500: a plain sentence and no membership line', async () => {
    script(u => (u === '/api/bureau' ? empty500() : undefined)); render(<BureauClientsPage />);
    expect(await screen.findByText('Could not load your bureaus - try again')).toBeTruthy();
    expect(screen.queryByText(/aren.t a member of any bureau/)).toBeNull();
    expectNoRawError();
  });
  it('200 with no bureaus: the membership line', async () => {
    script(u => (u === '/api/bureau' ? ok({ bureaus: [] }) : undefined)); render(<BureauClientsPage />);
    expect(await screen.findByText(/aren.t a member of any bureau/)).toBeTruthy();
  });
  it('clients 400 then: the server message shows and no stale client rows remain', async () => {
    script(u => (u === '/api/bureau' ? ok({ bureaus: [{ id: 'b1', name: 'D2 Bureau', role: 'owner' }] }) : u.includes('/api/bureau/clients') ? refuse() : undefined));
    render(<BureauClientsPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('clients empty-body 500: a plain sentence', async () => {
    script(u => (u === '/api/bureau' ? ok({ bureaus: [{ id: 'b1', name: 'D2 Bureau', role: 'owner' }] }) : u.includes('/api/bureau/clients') ? empty500() : undefined));
    render(<BureauClientsPage />);
    expect(await screen.findByText('Could not load the bureau clients - try again')).toBeTruthy();
    expectNoRawError();
  });
});

describe('financial-years', () => {
  const PERIOD = { id: 'p1', periodName: 'Jan', periodNumber: 1, fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-01-31', status: 'open' };
  it('journal counts: a refused counts call never parses its body and the page still shows the year', async () => {
    const refused = refuse(); const parse = vi.spyOn(refused, 'json');
    script(u => (u.includes('jeCounts=true') ? refused : u.includes('/fiscal-periods') ? ok([PERIOD]) : undefined));
    render(<FinancialYearsPage />);
    expect(await screen.findByText(/year 2026 counts \{\}/)).toBeTruthy();
    expect(parse).not.toHaveBeenCalled();
    expectNoRawError();
  });
  it('journal counts: an empty-body 500 raises no SyntaxError and shows no error banner', async () => {
    script(u => (u.includes('jeCounts=true') ? empty500() : u.includes('/fiscal-periods') ? ok([PERIOD]) : undefined));
    render(<FinancialYearsPage />);
    await screen.findByText(/year 2026/);
    expectNoRawError();
  });
  it('journal counts: a 200 reaches the card', async () => {
    script(u => (u.includes('jeCounts=true') ? ok({ p1: 7 }) : u.includes('/fiscal-periods') ? ok([PERIOD]) : undefined));
    render(<FinancialYearsPage />);
    expect(await screen.findByText(/counts \{"p1":7\}/)).toBeTruthy();
  });
  it('periods load failing leaves no stale year', async () => {
    script(u => (u.includes('/fiscal-periods') ? empty500() : undefined)); render(<FinancialYearsPage />);
    expect(await screen.findByText('Could not load fiscal periods - try again')).toBeTruthy();
    expect(screen.queryByText(/year 2026/)).toBeNull();
  });
  it('a failing refresh clears the old year instead of leaving it under the error', async () => {
    let calls = 0;
    script(u => (u.includes('jeCounts=true') ? ok({}) : u.includes('/fiscal-periods') ? (++calls === 1 ? ok([PERIOD]) : empty500()) : undefined));
    const { container } = render(<FinancialYearsPage />);
    await screen.findByText(/year 2026/);
    fireEvent.click(container.querySelector('svg.lucide-refresh-cw')!.closest('button')!);
    expect(await screen.findByText('Could not load fiscal periods - try again')).toBeTruthy();
    expect(screen.queryByText(/year 2026/)).toBeNull();
  });
  const addYear = async (write: () => Response) => {
    script((u, m) => (m === 'POST' ? write() : u.includes('/fiscal-periods') ? ok([PERIOD]) : undefined));
    render(<FinancialYearsPage />);
    await screen.findByText(/year 2026/);
    await click(/add new year/i);
    await click('add year go');
  };
  it('add year 400: the modal gets the server message', async () => {
    await addYear(refuse); await waitFor(() => expect(document.body.getAttribute('data-add-error')).toBe(MSG));
    // The page rethrows the request failure itself, not a re-wrapped ApiEnvelopeError.
    expect(document.body.getAttribute('data-add-error-class')).toBe('ApiRequestError');
  });
  it('add year empty-body 500: the modal gets a plain sentence', async () => {
    await addYear(empty500); await waitFor(() => expect(document.body.getAttribute('data-add-error')).toBe('Could not create the financial year - try again'));
    expect(document.body.getAttribute('data-add-error-class')).toBe('ApiRequestError');
  });
});

describe('adjustments: a failed load shows the error, not an empty table', () => {
  it('load 400: the message shows and "No adjustments" does not', async () => {
    script(u => (u.includes('/adjustments?') ? refuse() : undefined)); render(<AdjustmentsPage />);
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText('No adjustments')).toBeNull();
  });
  it('load empty-body 500: a plain sentence and no empty row', async () => {
    script(u => (u.includes('/adjustments?') ? empty500() : undefined)); render(<AdjustmentsPage />);
    expect(await screen.findByText('Could not load adjustments - try again')).toBeTruthy();
    expect(screen.queryByText('No adjustments')).toBeNull();
    expectNoRawError();
  });
  it('load 200 with nothing: the empty row', async () => {
    script(u => (u.includes('/adjustments?') ? ok({ items: [] }) : undefined)); render(<AdjustmentsPage />);
    expect(await screen.findByText('No adjustments')).toBeTruthy();
  });
});

describe('bank-accounts: edit reloads even when the second update fails', () => {
  it('name update 200, bank-number update 500: the error shows AND the card shows the new name', async () => {
    const A = { id: 'a1', accountCode: '1100', accountName: 'D2 Old Name', accountType: 'asset', isActive: true, txnCount: 0, totalDebits: 0, totalCredits: 0, balance: 0 };
    let renamed = false;
    script((u, m) => {
      if (m === 'PUT' && u.includes('chart-of-accounts')) { renamed = true; return ok({}); }
      if (m === 'PUT') return empty500();
      return u.includes('/bank-accounts') ? ok([renamed ? { ...A, accountName: 'D2 New Name' } : A]) : undefined;
    });
    render(<BankAccountsPage />);
    await click('edit card'); await click('edit save');
    await waitFor(() => expect(notify.error).toHaveBeenCalledWith('Could not update the bank account - try again'));
    expect(await screen.findByText('D2 New Name')).toBeTruthy();
    expect(screen.queryByText('D2 Old Name')).toBeNull();
  });
});

describe('new invoice: a 200 without an id is a failure, not /customer-invoices/undefined', () => {
  it('stays on the form with a plain sentence and never pushes', async () => {
    script((u, m) => (m === 'POST' && u.includes('customer-invoices-create') ? ok({}) : u.endsWith('/customers') ? ok([{ id: 'c-1', name: 'D2 Client' }]) : u.includes('currencies') ? ok([]) : undefined));
    render(<NewInvoicePage />);
    await screen.findByRole('option', { name: 'D2 Client' });
    fireEvent.change(document.querySelector('select[name="clientId"]')!, { target: { value: 'c-1' } });
    fireEvent.change(screen.getByPlaceholderText('Item description'), { target: { value: 'D2 work' } });
    fireEvent.change(document.querySelector('input[name="unitPrice"]')!, { target: { value: '50' } });
    await click(/^create invoice$/i);
    expect(await screen.findByText(/could not be opened - check the invoice list/)).toBeTruthy();
    expect(push).not.toHaveBeenCalled();
    expect(JSON.stringify(push.mock.calls)).not.toContain('undefined');
  });
});

