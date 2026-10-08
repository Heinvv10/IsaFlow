// D2 round 9 (pages/accounting): failure sentences and write paths the review found without a test.
//   an empty 5xx says WHAT could not be done (never "Failed to load" / "Something went wrong");
//   suppliers/new: the button stays busy while the detail page loads (no second supplier on a double click);
//   disclosure-notes delete: a refusal / dropped connection is shown; project-profitability: a failed reload clears the old rows;
//   balance-sheet / income-statement / cash-flow: a failed reference list is logged, not swallowed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, expectNoJargon, MSG, ok, on, refuse, serve, writeCalls } from '../helpers/d2R3a6';

const router = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', replace: vi.fn(), push: vi.fn(async () => true) }));
const warn = vi.hoisted(() => vi.fn());

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn, debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => router }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('next/head', () => ({ default: () => null }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ isAuthenticated: true, loading: false, user: { id: 'u-1', role: 'admin' } }) }));
vi.mock('@/components/accounting/AccountReportingGroupModal', () => ({ AccountReportingGroupModal: () => null }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/utils/toast', () => {
  const show = (m: string) => { const d = document.createElement('div'); d.setAttribute('data-toast', ''); d.textContent = m; document.body.appendChild(d); };
  return { notify: { error: show, success: show, info: show, warning: show } };
});

import { apiFetch } from '@/lib/apiFetch';
import SageMigrationPage from '../../../pages/accounting/sage-migration/index';
import SalesRepsPage from '../../../pages/accounting/sales-reps/index';
import ArAgingPage from '../../../pages/accounting/reports/ar-aging';
import ExecutiveDashboardPage from '../../../pages/accounting/reports/executive-dashboard';
import SupplierInvoicesPage from '../../../pages/accounting/supplier-invoices/index';
import AccountReportingGroupsPage from '../../../pages/accounting/settings/account-reporting-groups';
import CustomerInvoicesPage from '../../../pages/accounting/customer-invoices/index';
import ProjectProfitabilityPage from '../../../pages/accounting/reports/project-profitability';
import JournalEntryPage from '../../../pages/accounting/journal-entries/[entryId]';
import MigrationValidatePage from '../../../pages/accounting/migration/validate';
import EliminationsPage from '../../../pages/accounting/group/eliminations';
import Emp201Page from '../../../pages/accounting/sars/emp201';
import NewSupplierPage from '../../../pages/accounting/suppliers/new';
import DisclosureNotesPage from '../../../pages/accounting/reports/disclosure-notes';
import BalanceSheetPage from '../../../pages/accounting/reports/balance-sheet';
import IncomeStatementPage from '../../../pages/accounting/reports/income-statement';
import CashFlowPage from '../../../pages/accounting/reports/cash-flow';
import YearEndPage from '../../../pages/accounting/year-end/index';
import BankTransfersPage from '../../../pages/accounting/bank-transfers/index';
import PortalLoginPage from '../../../pages/accounting/afs/portal/login';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); warn.mockClear(); router.query = {}; router.isReady = true; router.push.mockClear(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); document.querySelectorAll('[data-toast]').forEach(n => n.remove()); });

describe('an empty 5xx names what could not be done', () => {
  const cases: Array<{ name: string; page: () => ReactNode; fails: string; says: string; query?: Record<string, string>; rest?: Parameters<typeof on> }> = [
    { name: 'sage migration', page: () => <SageMigrationPage />, fails: 'sage-migration', says: 'Could not load the Sage migration - try again' },
    { name: 'sales reps', page: () => <SalesRepsPage />, fails: 'sales-reps', says: 'Could not load the sales reps - try again' },
    { name: 'AR aging', page: () => <ArAgingPage />, fails: 'reports-ar-aging', says: 'Could not load the AR aging report - try again' },
    { name: 'executive summary', page: () => <ExecutiveDashboardPage />, fails: 'reports-executive-summary', says: 'Could not load the executive summary - try again' },
    { name: 'KPI scorecard', page: () => <ExecutiveDashboardPage />, fails: 'reports-kpi-scorecard', says: 'Could not load the KPI scorecard - try again' },
    { name: 'supplier invoices', page: () => <SupplierInvoicesPage />, fails: 'supplier-invoices?', says: 'Could not load the supplier invoices - try again' },
    { name: 'reporting groups', page: () => <AccountReportingGroupsPage />, fails: 'account-reporting-groups', says: 'Could not load the reporting groups - try again' },
    { name: 'customer invoices', page: () => <CustomerInvoicesPage />, fails: 'customer-invoices-list', says: 'Could not load the customer invoices - try again' },
    { name: 'project profitability', page: () => <ProjectProfitabilityPage />, fails: 'reports-project-profitability', says: 'Could not load the project profitability report - try again' },
    { name: 'journal entry', page: () => <JournalEntryPage />, fails: 'journal-entries-detail', says: 'Could not load the journal entry - try again', query: { entryId: 'je1' } },
  ];
  it.each(cases)('$name', async (c) => {
    router.query = c.query ?? {};
    serve(on('GET', c.fails, empty500));
    render(c.page() as JSX.Element);
    expect((await screen.findAllByText(c.says)).length).toBeGreaterThan(0);
    expectNoJargon();
    expect(document.body.textContent).not.toMatch(/Failed to load|Something went wrong/);
  });
});

describe('migration validate', () => {
  it('an empty 500 on validation names the validation', async () => {
    serve(on('GET', 'migration/session', () => ok({ session: { id: 's1', status: 'in_progress' } })), on('GET', 'migration/validate', empty500));
    render(<MigrationValidatePage />);
    expect(await screen.findByText('Could not validate the migration data - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Could not complete:|Validation failed/);
  });
});

describe('group eliminations', () => {
  it('an empty 500 on the adjustments load names them', async () => {
    serve(on('GET', 'company-groups', () => ok([{ id: 'g1', name: 'Group One' }])), on('GET', 'consolidated-reports', empty500));
    render(<EliminationsPage />);
    expect(await screen.findByText('Could not load the elimination adjustments - try again')).toBeTruthy();
  });
});

describe('group eliminations writes', () => {
  it('auto-generate on an empty 500 names the eliminations', async () => {
    serve(on('GET', 'company-groups', () => ok([{ id: 'g1', name: 'Group One' }])), on('POST', 'consolidated-reports', empty500), on('GET', 'consolidated-reports', () => ok({ items: [] })));
    render(<EliminationsPage />);
    await waitFor(() => expect((screen.getByRole('button', { name: /Auto/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button', { name: /Auto/ }));
    expect(await screen.findByText('Could not generate the eliminations - try again')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Auto-generation failed');
  });
});

describe('EMP201', () => {
  const DATA = { periodStart: '2026-08-01', periodEnd: '2026-08-31', totalPAYE: 1, totalETI: 0, payePayable: 1, totalUIF_employee: 1, totalUIF_employer: 1, totalUIF: 2, totalSDL: 1,
    employeeCount: 1, totalTaxableRemuneration: 10, totalDeductions: 1, payrollRuns: [] };
  it('generate, save-draft and submit each say which step failed on an empty 500', async () => {
    serve(on('GET', 'sars-emp201', empty500));
    const { unmount } = render(<Emp201Page />);
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    expect(await screen.findByText('Could not generate the EMP201 - try again')).toBeTruthy();
    unmount();

    serve(on('GET', 'sars-emp201', () => ok(DATA)), on('POST', 'sars-emp201', empty500));
    const second = render(<Emp201Page />);
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    expect(await screen.findByText('Could not save the EMP201 draft - try again')).toBeTruthy();
    second.unmount();

    serve(on('GET', 'sars-emp201', () => ok(DATA)), on('POST', 'sars-emp201', () => ok({ id: 'd1' })), on('POST', 'sars-submissions', empty500));
    render(<Emp201Page />);
    fireEvent.click(screen.getByRole('button', { name: /Generate/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Save Draft/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Mark as Submitted/ }));
    fireEvent.change(screen.getByPlaceholderText('SARS reference number'), { target: { value: 'REF1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(await screen.findByText('Could not mark the EMP201 as submitted - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Something went wrong/);
  });
});

describe('new supplier', () => {
  it('stays busy after a good save while the detail page loads, so a second click creates nothing', async () => {
    router.push.mockImplementation(() => new Promise<boolean>(() => undefined));
    serve(on('POST', 'suppliers-list', () => ok({ id: 's-1' })));
    render(<NewSupplierPage />);
    fireEvent.change(screen.getByPlaceholderText(/ABC Supplies/), { target: { value: 'D2 Supplier' } });
    const save = screen.getByRole('button', { name: /Save Supplier/ });
    fireEvent.click(save);
    await waitFor(() => expect(router.push).toHaveBeenCalledWith('/accounting/suppliers/s-1'));
    expect((screen.getByRole('button', { name: /Saving/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Saving/ }));
    expect(writeCalls('POST', 'suppliers-list')).toBe(1);
  });
  it('a refused save frees the button again and shows the server message', async () => {
    serve(on('POST', 'suppliers-list', () => refuse()));
    render(<NewSupplierPage />);
    fireEvent.change(screen.getByPlaceholderText(/ABC Supplies/), { target: { value: 'D2 Supplier' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Supplier/ }));
    await waitFor(() => expect([...document.querySelectorAll('[data-toast]')].map(n => n.textContent)).toContain(MSG));
    await waitFor(() => expect((screen.getByRole('button', { name: /Save Supplier/ }) as HTMLButtonElement).disabled).toBe(false));
  });
});

describe('disclosure notes delete', () => {
  const NOTE = { noteNumber: 20, title: 'D2 manual note', content: 'x', source: 'manual', id: 'n1' };
  const del = async (answer: () => Response) => {
    vi.stubGlobal('confirm', () => true);
    serve(on('GET', 'disclosure-notes?', () => ok({ notes: [NOTE] })), on('DELETE', 'disclosure-notes-manual', answer));
    render(<DisclosureNotesPage />);
    await screen.findByText('D2 manual note');
    fireEvent.click(document.querySelector('svg.lucide-trash-2')!.parentElement!);
  };
  it('a refusal shows the server message', async () => {
    await del(() => refuse());
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty 500 is a plain sentence', async () => {
    await del(empty500);
    expect(await screen.findByText('Could not delete the note - try again')).toBeTruthy();
    expectNoJargon();
  });
  it('a dropped connection is reported, not an unhandled rejection', async () => {
    await del(() => { throw new TypeError('Failed to fetch'); });
    expect(await screen.findByText('Could not delete the note - try again')).toBeTruthy();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });
  it('a good delete reloads the notes and shows no error', async () => {
    await del(() => ok({}));
    await waitFor(() => expect(vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('disclosure-notes?')).length).toBe(2));
    expect(screen.queryByText(/Could not delete/)).toBeNull();
  });
});

describe('project profitability', () => {
  it('a failed reload clears the old period\'s rows instead of leaving them under the error', async () => {
    const ROW = { projectId: 'p1', projectName: 'D2 Project', revenue: 100, costs: 40, profit: 60, margin: 60, revenueLines: [], costLines: [] };
    let n = 0;
    serve(on('GET', 'reports-project-profitability', () => (n++ === 0 ? ok([ROW]) : empty500())));
    render(<ProjectProfitabilityPage />);
    expect(await screen.findByText('D2 Project')).toBeTruthy();
    fireEvent.change(document.querySelector('input[type="date"]') as HTMLInputElement, { target: { value: '2025-02-01' } });
    expect(await screen.findByText('Could not load the project profitability report - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Project')).toBeNull();
  });
});

describe('report reference lists', () => {
  // the report body itself is refused too, so the page never renders a report from the helper's default empty list
  const failing = (part: string) => serve(on('GET', part, () => refuse()), on('GET', 'reports-', () => refuse()), on('GET', 'financial-statements', () => refuse()));
  it.each([
    ['balance sheet', () => <BalanceSheetPage />, 'cost-centres', 'Failed to load cost centres', 'balance-sheet'],
    ['balance sheet', () => <BalanceSheetPage />, 'business-units', 'Failed to load business units', 'balance-sheet'],
    ['income statement', () => <IncomeStatementPage />, 'cost-centres', 'Failed to load cost centres', 'income-statement'],
    ['income statement', () => <IncomeStatementPage />, 'business-units', 'Failed to load business units', 'income-statement'],
    ['cash flow', () => <CashFlowPage />, 'cost-centres', 'Failed to load cost centres', 'cash-flow'],
  ] as const)('%s (case %#): a failed reference list is logged and the page still renders', async (_n, page, part, msg, ctx) => {
    failing(part);
    render(page() as JSX.Element);
    await waitFor(() => expect(warn).toHaveBeenCalledWith(msg, expect.objectContaining({ err: expect.objectContaining({ message: MSG }) }), ctx));
  });
});

describe('an empty 5xx on a write names what could not be done', () => {
  const REP = { id: 'rep-1', name: 'Jane Smith', email: 'j@x.co', phone: null, is_active: true, created_at: '2026-01-01' };
  const GROUP = { id: 'g-1', name: 'Fixed Assets', report_type: 'balance_sheet', display_order: 0, member_count: 0, members: [], created_at: '2026-01-01' };
  const SESSION = { id: 's-1', status: 'in_progress' };
  const SAGE = { accounts: { sageTotal: 10, mapped: 5, unmapped: 5, autoMapped: 0 }, ledger: { sageTotal: 10, imported: 0, pending: 10, failed: 0, dateRange: { earliest: null, latest: null } },
    invoices: { sageTotal: 10, imported: 0, pending: 10, failed: 0 }, lastRuns: [] };
  const YEAR = { year_label: 'FY2025', start_date: '2025-03-01', end_date: '2026-02-28', status: 'open', periods_open: 0, periods_closed: 12, total_revenue: 1, total_expenses: 1, net_income: 0 };

  it('sales rep save', async () => {
    serve(on('PUT', 'sales-reps', empty500), on('GET', 'sales-reps', () => ok([REP])));
    render(<SalesRepsPage />);
    await screen.findByText('Jane Smith');
    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.click(await screen.findByRole('button', { name: 'Save Changes' }));
    expect(await screen.findByText('Could not save the sales rep - try again')).toBeTruthy();
  });
  it('sales rep deactivate', async () => {
    vi.stubGlobal('confirm', () => true);
    serve(on('PUT', 'sales-reps', empty500), on('GET', 'sales-reps', () => ok([REP])));
    render(<SalesRepsPage />);
    await screen.findByText('Jane Smith');
    fireEvent.click(screen.getByTitle('Deactivate'));
    expect(await screen.findByText('Could not update the sales rep - try again')).toBeTruthy();
  });
  it('reporting group delete', async () => {
    serve(on('DELETE', 'account-reporting-groups', empty500), on('GET', 'account-reporting-groups', () => ok({ items: [GROUP] })));
    render(<AccountReportingGroupsPage />);
    await screen.findByText('Fixed Assets');
    fireEvent.click(screen.getByTitle('Delete group'));
    fireEvent.click(screen.getByTitle('Click again to confirm delete'));
    expect(await screen.findByText('Could not delete the reporting group - try again')).toBeTruthy();
  });
  it('migration go-live', async () => {
    serve(on('POST', 'migration/session', empty500), on('GET', 'migration/session', () => ok({ session: SESSION })),
      on('GET', 'migration/validate', () => ok({ sessionId: 's-1', allPassed: true, checks: [{ id: 'c1', label: 'TB foots', passed: true, status: 'pass' }] })));
    render(<MigrationValidatePage />);
    fireEvent.click(await screen.findByRole('button', { name: /Complete Migration/ }));
    expect(await screen.findByText('Could not complete the migration - try again')).toBeTruthy();
  });
  it('sage migration step', async () => {
    serve(on('POST', 'sage-migration-action', empty500), on('GET', 'sage-migration', () => ok(SAGE)));
    render(<SageMigrationPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Auto-Map/ }));
    expect(await screen.findByText('Could not run that Sage migration step - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Could not complete:|Action failed/);
  });
  it('year-end processing', async () => {
    serve(on('POST', 'year-end', empty500), on('GET', 'year-end', () => ok({ years: [YEAR] })));
    render(<YearEndPage />);
    fireEvent.click(await screen.findByRole('button', { name: /Process Year-End/ }));
    expect(await screen.findByText('Could not run year-end processing - try again')).toBeTruthy();
  });
});

describe('bank transfer', () => {
  it('an empty 500 says the transfer could not be recorded', async () => {
    // GET chart-of-accounts?subtype=bank answers a plain camelCased array.
    const ACCTS = [{ id: 'a1', accountCode: '1000', accountName: 'Cheque' }, { id: 'a2', accountCode: '1010', accountName: 'Savings' }];
    serve(on('POST', 'bank-transfers', empty500), on('GET', 'chart-of-accounts', () => ok(ACCTS)));
    render(<BankTransfersPage />);
    await screen.findAllByText(/1000 — Cheque/);
    const [from, to] = screen.getAllByRole('combobox');
    fireEvent.change(from!, { target: { value: 'a1' } });
    fireEvent.change(to!, { target: { value: 'a2' } });
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '50' } });
    fireEvent.click(screen.getByRole('button', { name: /Transfer/ }));
    expect(await screen.findByText('Could not record the transfer - try again')).toBeTruthy();
  });
});

describe('afs portal sign-in', () => {
  it.each([['a refused request', () => new Response('', { status: 500 })], ['a dropped connection', () => { throw new TypeError('fetch failed'); }]])('%s says the link could not be sent', async (_n, answer) => {
    vi.stubGlobal('fetch', vi.fn(async () => answer()));
    render(<PortalLoginPage />);
    fireEvent.change(screen.getByPlaceholderText('you@example.com'), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send sign-in link' }));
    expect(await screen.findByText('Could not send the sign-in link - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Something went wrong/);
  });
});
