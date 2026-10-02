// Census group 5 (bank transactions, loans, supplier migration, supplier invoice form): a 4xx shows the server's
// message, an empty 5xx body shows a plain sentence (never "Unexpected end of JSON input"), a 200 still renders.
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const router = vi.hoisted(() => ({ push: vi.fn(), query: { id: 'loan-1' } as Record<string, string>, pathname: '/' }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/lib/logger', () => ({ log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() } }));
// bank transactions: one bank account is selected on mount; the table is a stub that lists descriptions
vi.mock('@/components/accounting/bank-transactions/useBankTxRefData', () => ({
  useBankTxRefData: (s: { setBankAccounts: (v: unknown[]) => void; setSelectedBank: (f: () => string) => void; setRefDataLoaded: (v: boolean) => void }) => {
    useEffect(() => { s.setBankAccounts([{ id: 'b1', accountCode: '1100', accountName: 'D2 Bank' }]); s.setSelectedBank(() => 'b1'); s.setRefDataLoaded(true); }, []); // eslint-disable-line react-hooks/exhaustive-deps
    return { refreshBankAccounts: vi.fn() };
  },
}));
vi.mock('@/components/accounting/bank-transactions/useBankTxActions', () => ({ buildBankTxActions: () => ({}) }));
vi.mock('@/components/accounting/BankTxTable', () => ({ BankTxTable: ({ transactions }: { transactions: { id: string; description?: string }[] }) => <ul>{transactions.map(t => <li key={t.id}>{t.description}</li>)}</ul> }));
vi.mock('@/components/accounting/bank-transactions/BankTxBankCards', () => ({ BankTxBankCards: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxFilters', () => ({ BankTxFilters: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxBatchPanel', () => ({ BankTxBatchPanel: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxModals', () => ({ BankTxModals: () => null }));
vi.mock('@/components/accounting/bank-transactions/BankTxSuppliersNotice', () => ({ BankTxSuppliersNotice: () => null }));
vi.mock('@/components/accounting/bank-transactions/AutoPostRunsPanel', () => ({ AutoPostRunsPanel: () => null }));
vi.mock('@/components/accounting/banking/BankEmptyState', () => ({ BankEmptyState: () => null }));
// loans: tab bodies are stubs that print what they were given
vi.mock('@/components/loans/LoanStatusBadge', () => ({ LoanStatusBadge: () => null }));
vi.mock('@/components/loans/LoanOverviewTab', () => ({ LoanOverviewTab: () => <div>overview</div> }));
vi.mock('@/components/loans/LoanScheduleTab', () => ({ LoanScheduleTab: ({ rows }: { rows: unknown[] }) => <div>SCHEDULE {JSON.stringify(rows)}</div> }));
vi.mock('@/components/loans/LoanEventsTab', () => ({ LoanEventsTab: ({ events }: { events: unknown[] }) => <div>EVENTS {JSON.stringify(events)}</div> }));
vi.mock('@/components/loans/LoanRateCurveTab', () => ({ LoanRateCurveTab: () => null }));
vi.mock('@/components/loans/LoanComplianceTab', () => ({ LoanComplianceTab: () => null }));
// supplier invoice form: children that fetch or are not under test are stubs
vi.mock('@/components/accounting/ScanAndFillButton', () => ({ ScanAndFillButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));
vi.mock('@/components/accounting/supplier-invoices/matchVendorSupplier', () => ({ useVendorSupplierMatch: () => ({ scan: vi.fn(), notePick: vi.fn() }) }));
vi.mock('@/components/accounting/suppliers/PoGrnSelector', () => ({ PoGrnSelector: () => null }));
vi.mock('@/components/accounting/suppliers/SupplierInvoiceSummaryCard', () => ({ SupplierInvoiceSummaryCard: () => null }));
vi.mock('@/components/accounting/suppliers/BillLineItemsTable', () => ({ BillLineItemsTable: ({ glAccounts }: { glAccounts: { accountName: string }[] }) => <div>{glAccounts.map(a => a.accountName).join(',')}</div> }));
vi.mock('@/components/accounting/suppliers/InvoiceNumberField', () => ({ InvoiceNumberField: ({ sequencePreview }: { sequencePreview: string }) => <div>NUMBER {sequencePreview}</div> }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
useApiJsonOverMock();

import { apiFetch } from '@/lib/apiFetch';
import BankTransactionsPage from '../../../pages/accounting/bank-transactions/index';
import LoanDetailPage from '../../../pages/accounting/loans/[id]';
import SuppliersImportPage from '../../../pages/accounting/migration/suppliers';
import NewSupplierInvoicePage from '../../../pages/accounting/supplier-invoices/new';

const MSG = 'D2 server says no: not allowed here';
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const refused = () => new Response(JSON.stringify({ success: false, error: { code: 'BAD_REQUEST', message: MSG } }), { status: 400 });
const empty500 = () => new Response('', { status: 500 });
afterEach(() => { vi.mocked(apiFetch).mockReset(); });
const bodyText = () => document.body.textContent ?? '';
const noParserText = () => expect(bodyText()).not.toMatch(/JSON|Unexpected end/);
type Match = (url: string) => boolean;
function script(match: Match, main: () => Response, rest: () => Response = () => ok({})) {
  vi.mocked(apiFetch).mockImplementation(async (u: unknown) => (match(String(u)) ? main() : rest()));
}

describe('bank transactions list', () => {
  const m: Match = u => u.includes('/api/accounting/bank-transactions?');
  const data = { transactions: [{ id: 't1', transactionDate: '2026-01-01', description: 'D2 bank line', amount: 5, status: 'imported' }], total: 1 };
  it('shows the server message on a 400', async () => { script(m, refused); render(<BankTransactionsPage />); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('shows a plain sentence on an empty 500', async () => {
    script(m, empty500); render(<BankTransactionsPage />);
    await waitFor(() => expect(bodyText()).toContain('Could not load transactions')); noParserText();
  });
  it('renders the rows on a 200', async () => { script(m, () => ok(data)); render(<BankTransactionsPage />); await waitFor(() => expect(bodyText()).toContain('D2 bank line')); });
});

describe('loan detail schedule and events tabs', () => {
  const loan = { id: 'loan-1-aaaa', reference: 'LOAN-D2-1', status: 'active', curveId: null };
  const open = (path: string, main: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async (u: unknown) => {
      const url = String(u);
      if (url.endsWith(path)) return main();
      return url.endsWith('/loans/loan-1') ? ok(loan) : ok({});
    });
    render(<LoanDetailPage />);
  };
  const tab = async (name: string) => fireEvent.click(await screen.findByRole('button', { name }));
  it('schedule: shows the server message on a 400', async () => { open('/schedule', refused); await tab('Schedule'); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('schedule: shows a plain sentence on an empty 500', async () => {
    open('/schedule', empty500); await tab('Schedule');
    await waitFor(() => expect(bodyText()).toContain('Could not load the repayment schedule')); noParserText();
  });
  it('schedule: renders the rows on a 200', async () => { open('/schedule', () => ok({ rows: [{ marker: 'D2_SCHEDULE_ROW' }] })); await tab('Schedule'); await waitFor(() => expect(bodyText()).toContain('D2_SCHEDULE_ROW')); });
  it('events: shows the server message on a 400', async () => { open('/events', refused); await tab('Events'); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('events: shows a plain sentence on an empty 500', async () => {
    open('/events', empty500); await tab('Events');
    await waitFor(() => expect(bodyText()).toContain('Could not load the loan events')); noParserText();
  });
  it('events: renders the events on a 200', async () => { open('/events', () => ok([{ marker: 'D2_EVENT_ROW' }])); await tab('Events'); await waitFor(() => expect(bodyText()).toContain('D2_EVENT_ROW')); });
});

describe('supplier migration import', () => {
  async function runImport(session: () => Response) {
    const post = () => ok({ succeeded: 7, failed: 0, skipped: 0 });
    vi.mocked(apiFetch).mockImplementation(async (u: unknown) => (String(u).includes('/migration/session') ? session() : post()));
    const { container } = render(<SuppliersImportPage />);
    const file = new File(['name\nD2 Supplier\n'], 'suppliers.csv', { type: 'text/csv' });
    fireEvent.change(container.querySelector('input[type="file"]') as HTMLInputElement, { target: { files: [file] } });
    fireEvent.click(await screen.findByRole('button', { name: /Import 1 Suppliers/ }));
  }
  it('shows the server message on a 400', async () => { await runImport(refused); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('shows a plain sentence on an empty 500', async () => {
    await runImport(empty500); await waitFor(() => expect(bodyText()).toContain('Could not load the migration session')); noParserText();
  });
  it('imports on a 200', async () => { await runImport(() => ok({ id: 'sess-1' })); await waitFor(() => expect(bodyText()).toContain('Imported 7 suppliers')); });
});

describe('supplier invoice form reference data', () => {
  const accounts = [{ id: 'g1', accountCode: '5100', accountName: 'D2 Expense Account' }];
  const settings = [{ documentType: 'supplier_invoice', prefix: 'D2SIV-', nextNumber: 7, padding: 4 }];
  const serve = (chart: () => Response, docNums: () => Response) => {
    vi.mocked(apiFetch).mockImplementation(async (u: unknown) => (String(u).includes('chart-of-accounts') ? chart() : String(u).includes('company-settings') ? docNums() : ok({})));
    render(<NewSupplierInvoicePage />);
  };
  it('shows the server message on a 400', async () => { serve(() => ok(accounts), refused); await waitFor(() => expect(bodyText()).toContain(MSG)); });
  it('shows a plain sentence on an empty 500', async () => {
    serve(empty500, () => ok(settings)); await waitFor(() => expect(bodyText()).toContain('Could not load the form data')); noParserText();
  });
  it('renders the accounts and the sequence on a 200', async () => {
    serve(() => ok(accounts), () => ok(settings));
    await waitFor(() => { expect(bodyText()).toContain('D2 Expense Account'); expect(bodyText()).toContain('NUMBER D2SIV-0007'); });
  });
});
