/**
 * D2 round 3 (a3): provisional entries (load, attach, dismiss) and the bank-transactions list (stale rows after a
 * failed reload, transfer re-link refusal, column-setting reads). A 400 shows the server's message, an empty-body
 * 500 a plain sentence (never "Network error" / a JSON parse error), a 200 takes effect.
 */
import { useEffect } from 'react';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/bank-transactions/useBankTxRefData', () => ({
  useBankTxRefData: (s: { setBankAccounts: (v: unknown[]) => void; setSelectedBank: (f: () => string) => void; setRefDataLoaded: (v: boolean) => void }) => {
    useEffect(() => { s.setBankAccounts([{ id: 'b1', accountCode: '1100', accountName: 'D2 Bank' }]); s.setSelectedBank(() => 'b1'); s.setRefDataLoaded(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return { refreshBankAccounts: vi.fn() };
  },
}));
vi.mock('@/components/accounting/bank-transactions/useBankTxActions', () => ({ buildBankTxActions: () => ({}) }));
vi.mock('@/components/accounting/BankTxTable', () => ({ BankTxTable: ({ transactions }: { transactions: { id: string; description?: string }[] }) => <ul>{transactions.map(t => <li key={t.id}>{t.description}</li>)}</ul> }));
vi.mock('@/components/accounting/bank-transactions/BankTxFilters', () => ({ BankTxFilters: ({ onRefresh, total }: { onRefresh: () => void; total: number }) => <div><button onClick={onRefresh}>REFRESH-TX</button><span>TOTAL:{total}</span></div> }));
vi.mock('@/components/accounting/bank-transactions/BankTxBankCards', () => ({ BankTxBankCards: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxBatchPanel', () => ({ BankTxBatchPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxModals', () => ({ BankTxModals: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxSuppliersNotice', () => ({ BankTxSuppliersNotice: () => null }));
vi.mock('@/components/accounting/bank-transactions/AutoPostRunsPanel', () => ({ AutoPostRunsPanel: () => null }));
vi.mock('@/components/accounting/banking/BankEmptyState', () => ({ BankEmptyState: () => null }));

import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import ProvisionalPage from '../../../pages/accounting/bank/provisional';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';
import { MSG, bad, boom, expectNoRawJsonError, ok } from '../helpers/d2CensusG4';
import { trio3 } from '../helpers/d2R3a3';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
afterEach(() => { cleanup(); vi.mocked(log.warn).mockClear(); });

const clickBtn = async (name: RegExp) => fireEvent.click(await screen.findByRole('button', { name }));
const PROV = { jeId: 'je-1', bankTxId: 'tx-1', bankAccountName: 'D2 Bank', description: 'D2 provisional line', amount: 100, transactionDate: '2031-03-01', daysOutstanding: 4,
  predictedSupplierId: null, predictedSupplierName: 'D2 Supplier', predictionConfidence: 0.9, glAccountId: null, glAccountName: null, postedAt: '2031-03-01' };
const DOC = { id: 'd-1', fileName: 'd2-evidence.pdf', vendorName: 'D2 Vendor', documentDate: null, totalAmount: 1, documentType: 'invoice' };
const provOthers = (u: string) => {
  if (u.includes('provisional/outstanding')) return ok({ outstanding: [PROV] });
  if (u.includes('document-capture')) return ok([DOC]);
  return undefined;
};

describe('provisional entries', () => {
  it('a failed load shows the server message and no rows; an empty 500 a plain sentence', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => bad());
    render(<ProvisionalPage />);
    expect((await screen.findAllByText(MSG)).length).toBeGreaterThan(0);
    cleanup();
    vi.mocked(apiFetch).mockReset().mockImplementation(async () => boom());
    render(<ProvisionalPage />);
    expect(await screen.findByText('Could not load the provisional entries - try again')).toBeTruthy();
    expect(screen.queryByText('D2 provisional line')).toBeNull(); expectNoRawJsonError();
  });
  it('reload after a good dismiss fails: the old row is cleared', async () => {
    let loads = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/dismiss')) return ok({ success: true });
      if (u.includes('provisional/outstanding')) return ++loads === 1 ? ok({ outstanding: [PROV] }) : boom();
      return provOthers(u) ?? ok({});
    });
    render(<ProvisionalPage />);
    await screen.findByText('D2 provisional line');
    await clickBtn(/^dismiss$/i);
    await clickBtn(/dismiss & reverse/i);
    expect(await screen.findByText('Could not load the provisional entries - try again')).toBeTruthy();
    expect(screen.queryByText('D2 provisional line')).toBeNull();
  });
  trio3({ name: 'attach evidence', render: () => render(<ProvisionalPage />), drive: async () => { await clickBtn(/attach evidence/i); await clickBtn(/D2 Vendor/); },
    match: (u, i) => u.includes('/attach') && i?.method === 'POST', data: {}, others: provOthers, plain: 'Could not attach the evidence - try again',
    succeeds: async () => { expect(await screen.findByText('Evidence attached successfully')).toBeTruthy(); },
    stays: () => { expect(screen.queryByText('Evidence attached successfully')).toBeNull(); } });
  trio3({ name: 'dismiss entry', render: () => render(<ProvisionalPage />), drive: async () => { await clickBtn(/^dismiss$/i); await clickBtn(/dismiss & reverse/i); },
    match: u => u.includes('/dismiss'), data: { success: true }, others: provOthers, plain: 'Could not dismiss the entry - try again',
    succeeds: async () => { expect(await screen.findByText(/Provisional entry reversed/)).toBeTruthy(); },
    stays: () => { expect(screen.queryByText(/Provisional entry reversed/)).toBeNull(); } });
});

describe('bank-transactions list', () => {
  const TXS = { transactions: [{ id: 't1', transactionDate: '2031-01-01', description: 'D2 bank row', amount: 5, status: 'imported' }], total: 1 };
  it('a failed reload clears the rows from the old filter and shows the error', async () => {
    let loads = 0;
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('/api/accounting/bank-transactions?')) return ++loads === 1 ? ok(TXS) : bad();
      return ok({});
    });
    render(<BankTransactionsPage />);
    await screen.findByText('D2 bank row');
    expect(screen.getByText('TOTAL:1')).toBeTruthy();
    await clickBtn(/refresh-tx/i);
    expect((await screen.findAllByText(MSG)).length).toBeGreaterThan(0);
    expect(screen.queryByText('D2 bank row')).toBeNull();
    expect(screen.getByText('TOTAL:0')).toBeTruthy();
  });
  it('a refused transfer re-link tells the user; an empty 500 does too without raw JSON', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => (String(url).includes('relink') ? boom() : ok({})));
    render(<BankTransactionsPage />);
    expect(await screen.findByText(/Transfer re-linking failed/)).toBeTruthy();
    expectNoRawJsonError();
  });
  it('a failing column-setting read is logged, not silent, and the list still loads', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.includes('accounting-settings')) return boom();
      return u.includes('/api/accounting/bank-transactions?') ? ok(TXS) : ok({});
    });
    render(<BankTransactionsPage />);
    expect(await screen.findByText('D2 bank row')).toBeTruthy();
    await vi.waitFor(() => expect(vi.mocked(log.warn)).toHaveBeenCalledWith('Column settings unavailable, using defaults', expect.anything(), 'bank-transactions'));
  });
});
