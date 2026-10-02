/**
 * D2 round 3 (a5): a reload that fails must not leave the previous rows on screen under the new
 * filter / period / toggle. Each case loads good rows, changes the filter, answers the reload with an
 * empty-body 500 and expects the old rows gone and a plain sentence shown (never JSON / HTTP text).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, empty500, expectNoRawError, ok, refuse, script } from '../helpers/d2R3a5';

configure({ asyncUtilTimeout: 4000 });
const route = vi.hoisted(() => ({ query: {} as Record<string, string> }));
const stmt = vi.hoisted(() => ({ fail: null as null | (() => Promise<never>) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/utils/toast', () => ({ notify: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: route.query, isReady: true, push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/accounting/supplier-invoices/SupplierSelect', () => ({ SupplierSelect: () => null }));
vi.mock('@/contexts/CompanyContext', () => { const activeCompany = { id: 'co-1' }; return { useCompany: () => ({ activeCompany }) }; });
vi.mock('@/components/accounting/AccountCategorySidebar', async (orig) => ({ ...(await orig<object>()), AccountCategorySidebar: () => null }));
vi.mock('@/components/accounting/dashboard/AccountRow', () => ({ AccountRow: ({ account }: { account: { accountName: string } }) => <tr><td>{account.accountName}</td></tr> }));
vi.mock('@/components/accounting/dashboard/CoaSeedEmptyState', () => ({ CoaSeedEmptyState: () => <p>seed state</p> }));
vi.mock('@/components/accounting/dashboard/AddAccountForm', () => ({ AddAccountForm: () => null }));
vi.mock('@/components/ui/ConfirmDialog', () => ({ ConfirmDialog: () => null }));
vi.mock('@/components/accounting/fiscal-periods/CloseReadinessChecklist', () => ({ CloseReadinessChecklist: () => null }));
vi.mock('@/components/accounting/fiscal-periods/CreateYearModal', () => ({ CreateYearModal: () => null }));
vi.mock('@/components/accounting/fiscal-periods/BulkConfirmModal', () => ({ BulkConfirmModal: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>confirm bulk</button> }));

vi.mock('@/modules/accounting/hooks/useStatementEmail', () => ({
  useStatementEmail: () => ({ emailProgress: null, toast: null, isSending: false, emailableCount: () => 1, sendEmails: () => stmt.fail!(), dismissToast: vi.fn() }),
}));
vi.mock('@/modules/accounting/utils/generateStatementsBatch', () => ({ generateStatementsBatch: () => stmt.fail!() }));

import { ApiRequestError } from '@/lib/apiFetch';
import BudgetsPage from '../../../pages/accounting/budgets/index';
import AdjustmentsPage from '../../../pages/accounting/adjustments/index';
import DataArchivingPage from '../../../pages/accounting/data-archiving';
import PurchaseOrdersPage from '../../../pages/accounting/purchase-orders/index';
import SupplierPaymentsPage from '../../../pages/accounting/supplier-payments/index';
import SupplierCreditNotesPage from '../../../pages/accounting/supplier-credit-notes/index';
import StatementRunPage from '../../../pages/accounting/statement-run/index';
import { ChartOfAccountsTab } from '../../../src/components/accounting/dashboard/ChartOfAccountsTab';
import { FiscalPeriodsTab } from '../../../src/components/accounting/dashboard/FiscalPeriodsTab';

useApiJsonOverMock();
afterEach(() => { cleanup(); route.query = {}; });

const dateInput = (c: HTMLElement) => c.querySelector('input[type="date"]')!;
const OTHER_YEAR = new Date().getFullYear() === 2024 ? 2025 : 2024;

describe('a failed reload clears the previous rows', () => {
  it('budgets: change the fiscal year', async () => {
    const row = { id: 'b1', glAccountId: 'g0', accountCode: '4000', accountName: 'D2 Sales Budget', accountType: 'revenue', fiscalYear: 2026, annualAmount: 1200, months: Array(12).fill(100) };
    script(u => (u.includes(`fiscal_year=${OTHER_YEAR}`) ? empty500() : u.includes('/budgets?') ? ok({ items: [row] }) : ok([])));
    render(<BudgetsPage />);
    await screen.findByText('D2 Sales Budget');
    fireEvent.change(screen.getAllByRole('combobox')[0]!, { target: { value: String(OTHER_YEAR) } });
    expect(await screen.findByText('Could not load budgets - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 Sales Budget')).toBeNull());
    expect(screen.queryByText(/accounts budgeted/)).toBeNull();
    expectNoRawError();
  });

  it('adjustments: switch the entity type', async () => {
    const row = { id: 'j1', adjustmentNumber: 'D2-ADJ-1', entityType: 'customer', entityId: 'c1', entityName: 'D2 Client', adjustmentType: 'debit', amount: 10, reason: 'r', adjustmentDate: '2026-01-01', status: 'draft' };
    script(u => (u.includes('entityType=supplier') ? empty500() : u.includes('entityType=customer') ? ok({ items: [row] }) : ok([])));
    const { rerender } = render(<AdjustmentsPage />);
    await screen.findByText('D2-ADJ-1');
    route.query = { type: 'supplier' };
    rerender(<AdjustmentsPage />);
    expect(await screen.findByText('Could not load adjustments - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2-ADJ-1')).toBeNull());
    expectNoRawError();
  });

  it('data archiving: change the archived-data date filter', async () => {
    const item = { id: 'e1', entryNumber: 'D2-JE-1', entryDate: '2020-01-01', description: 'D2 archived entry', source: 'manual', status: 'posted' };
    script(u => (u.includes('date_from=') ? empty500() : ok({ stats: [], runs: [], items: [item], total: 1 })));
    const { container } = render(<DataArchivingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /view archived data/i }));
    await screen.findByText('D2 archived entry');
    fireEvent.change(dateInput(container), { target: { value: '2020-02-01' } });
    expect(await screen.findByText('Could not load archived data - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 archived entry')).toBeNull());
    expect(screen.queryByText(/Showing \d/)).toBeNull();
    expectNoRawError();
  });

  it('chart of accounts: toggle show-inactive', async () => {
    const acct = { id: 'a1', accountCode: '1000', accountName: 'D2 Petty Cash', accountType: 'asset', isActive: true };
    script(u => (u.includes('includeInactive=true') ? empty500() : ok([acct])));
    render(<ChartOfAccountsTab />);
    await screen.findByText('D2 Petty Cash');
    fireEvent.click(screen.getByLabelText(/show inactive/i));
    // Wait for the reload to settle (the table is hidden while loading, so "row gone" alone would pass vacuously).
    expect(await screen.findByText('Could not load the chart of accounts - try again')).toBeTruthy();
    await waitFor(() => expect(document.querySelector('.animate-spin')).toBeNull());
    expect(screen.queryByText('D2 Petty Cash')).toBeNull();
    // A failed load is not an empty chart: no "seed the chart" offer, and the toggles stay usable.
    expect(screen.queryByText('seed state')).toBeNull();
    expect(screen.getByLabelText(/show inactive/i)).toBeTruthy();
    expectNoRawError();
  });

  it('purchase orders: change the status tab', async () => {
    const po = { id: 'o1', po_number: 'D2-PO-1', supplier_name: 'D2 Supplier', order_date: '2026-01-01', total: 10, status: 'draft' };
    script(u => (u.includes('status=draft') ? empty500() : ok([po])));
    render(<PurchaseOrdersPage />);
    await screen.findByText('D2-PO-1');
    fireEvent.click(screen.getByRole('button', { name: 'draft' }));
    expect(await screen.findByText('Could not load purchase orders - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2-PO-1')).toBeNull());
    expectNoRawError();
  });

  it('supplier payments: change the status tab', async () => {
    const pay = { id: 'p1', paymentNumber: 'D2-SP-1', supplierName: 'D2 Payee', paymentDate: '2026-01-01', totalAmount: 10, paymentMethod: 'eft', status: 'draft' };
    script(u => (u.includes('status=draft') ? empty500() : ok({ payments: [pay], total: 1 })));
    render(<SupplierPaymentsPage />);
    await screen.findByText('D2-SP-1');
    fireEvent.click(screen.getByRole('button', { name: 'draft' }));
    expect(await screen.findByText('Could not load payments - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2-SP-1')).toBeNull());
    expectNoRawError();
  });

  it('supplier credit notes: change the status tab', async () => {
    const cn = { id: 'c1', creditNoteNumber: 'D2-SCN-1', supplierName: 'D2 Creditor', creditDate: '2026-01-01', totalAmount: 10, status: 'draft' };
    script(u => (u.includes('status=draft') ? empty500() : ok({ creditNotes: [cn], total: 1 })));
    render(<SupplierCreditNotesPage />);
    await screen.findByText('D2-SCN-1');
    fireEvent.click(screen.getByRole('button', { name: 'draft' }));
    expect(await screen.findByText('Could not load supplier credit notes - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2-SCN-1')).toBeNull());
    expectNoRawError();
  });

  it('statement run: change the as-at date', async () => {
    const cust = { client_id: 'c1', client_name: 'D2 Statement Client', total_invoiced: 100, total_paid: 0, total_credits: 0, balance: 100, invoice_count: 1 };
    script(u => (u.includes('as_at_date=2025-03-01') ? empty500() : ok({ customers: [cust] })));
    const { container } = render(<StatementRunPage />);
    await screen.findByText('D2 Statement Client');
    fireEvent.change(dateInput(container), { target: { value: '2025-03-01' } });
    expect(await screen.findByText('Could not load customers - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 Statement Client')).toBeNull());
    expectNoRawError();
  });
});

describe('statement run: generate / email failures', () => {
  const cust = { client_id: 'c1', client_name: 'D2 Statement Client', total_invoiced: 100, total_paid: 0, total_credits: 0, balance: 100, invoice_count: 1 };
  const selectOne = async () => {
    script(() => ok({ customers: [cust] }));
    const { container } = render(<StatementRunPage />);
    await screen.findByText('D2 Statement Client');
    fireEvent.click(container.querySelector('svg.lucide-square')!.closest('button')!);
  };
  it('generate refused: the server reason shows', async () => {
    stmt.fail = async () => { throw new ApiRequestError(MSG, 400); };
    await selectOne();
    fireEvent.click(screen.getByRole('button', { name: /^Generate \(1\)/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('generate failing without a server message: a plain sentence, not "Failed to generate statements"', async () => {
    stmt.fail = async () => { throw new Error('boom'); };
    await selectOne();
    fireEvent.click(screen.getByRole('button', { name: /^Generate \(1\)/ }));
    expect(await screen.findByText('Could not generate the statements - try again')).toBeTruthy();
    expectNoRawError();
  });
  it('email refused: the server reason shows', async () => {
    vi.stubGlobal('confirm', () => true);
    stmt.fail = async () => { throw new ApiRequestError(MSG, 400); };
    await selectOne();
    fireEvent.click(screen.getByRole('button', { name: /^Email/ }));
    expect(await screen.findByText(MSG)).toBeTruthy();
    vi.unstubAllGlobals();
  });
});

describe('fiscal periods tab', () => {
  const period = { id: 'p1', periodName: 'D2 January 2026', periodNumber: 1, fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-01-31', status: 'open', createdAt: '2026-01-01', updatedAt: '2026-01-01' };
  const api = (write: () => Response, reload?: () => Response) => (_u: string, m: string) => (m !== 'GET' ? write() : reload ? reload() : ok([period]));
  const loaded = async () => { render(<FiscalPeriodsTab />); await screen.findByText('D2 January 2026'); };
  const closePeriod = () => fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  it('an action the server refuses shows the reason and keeps the period', async () => {
    script(api(refuse));
    await loaded(); closePeriod();
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.getByText('D2 January 2026')).toBeTruthy();
  });

  it('an action answered by an empty-body 500 shows a plain sentence', async () => {
    script(api(empty500));
    await loaded(); closePeriod();
    expect(await screen.findByText('Could not update the fiscal period - try again')).toBeTruthy();
    expectNoRawError();
  });

  it('an action that went through followed by a failing reload clears the old periods and shows the reload error', async () => {
    let done = false;
    script(api(() => { done = true; return ok({}); }, () => (done ? empty500() : ok([period]))));
    await loaded(); closePeriod();
    expect(await screen.findByText('Could not load fiscal periods - try again')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('D2 January 2026')).toBeNull());
    expect(document.querySelector('.animate-spin')).toBeNull();
  });

  const bulk = async () => {
    await loaded();
    fireEvent.click(screen.getByLabelText('Select D2 January 2026'));
    fireEvent.click(screen.getByRole('button', { name: /^Close \(1\)/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'confirm bulk' }));
  };

  it('a refused bulk action shows the server reason, not a bare Failed', async () => {
    script(api(refuse));
    await bulk();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });

  it('a bulk action answered by an empty-body 500 shows a plain sentence', async () => {
    script(api(empty500));
    await bulk();
    expect(await screen.findByText(/Could not run the bulk action - try again/)).toBeTruthy();
    expectNoRawError();
  });
});
