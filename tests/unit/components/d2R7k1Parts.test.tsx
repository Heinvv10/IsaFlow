/**
 * D2 round 7 (k1): a pay-package apply, the top-customers widget, the loan components check, the bank-feed accounts list,
 * the command palette search and the migration wizard say what failed instead of dropping the response.
 * REAL assertOk / apiErrorMessage over a scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { log } from '@/lib/logger';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1' } }) }));
vi.mock('@/contexts/ThemeContext', () => ({ useTheme: () => ({ toggleTheme: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/utils/toast', () => {
  const show = (m: string) => { const d = document.createElement('div'); d.setAttribute('data-toast', ''); d.textContent = m; document.body.appendChild(d); };
  return { notify: { error: show, success: show, info: show, warning: show } };
});
vi.mock('@/components/accounting/migration/AccountMappingTable', () => ({
  AccountMappingTable: ({ onAutoMap }: { onAutoMap: () => void }) => <button onClick={onAutoMap}>auto-map</button>,
}));
vi.mock('@/components/accounting/migration/WizardParts', async (orig) => ({
  ...(await orig<typeof import('@/components/accounting/migration/WizardParts')>()),
  FileUploadZone: ({ label, onFile }: { label: string; onFile: (f: File) => void }) => (
    <button onClick={() => onFile(new File(['x'], 'a.csv'))}>{`upload ${label}`}</button>
  ),
}));

import { ApplyPackageCard } from '@/components/payroll/ApplyPackageCard';
import LoansListPage from '../../../pages/payroll/loans/index';
import BankFeedsPage from '../../../pages/accounting/bank-feeds/index';
import CompliancePage from '../../../pages/accounting/practice/reports/compliance';
import { CommandPalette } from '@/components/layout/CommandPalette';
import { ExternalMigrationWizard } from '@/components/accounting/migration/ExternalMigrationWizard';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); vi.mocked(log.warn).mockClear(); });
afterEach(() => { cleanup(); document.querySelectorAll('[data-toast]').forEach(n => n.remove()); });
const toasts = () => [...document.querySelectorAll('[data-toast]')].map(n => n.textContent ?? '');

describe('ApplyPackageCard apply', () => {
  const run = async (apply: () => Response) => {
    route((u, m) => (m === 'POST' ? apply() : ok([{ id: 'p1', code: 'PKG1', name: 'Pack', isActive: true }])));
    render(<ApplyPackageCard employeeId="e-1" />);
    fireEvent.change(await screen.findByRole('combobox'), { target: { value: 'p1' } });
    fireEvent.click(screen.getByRole('button', { name: /apply package/i }));
  };
  it('a 400 shows the server message and no success line', async () => {
    await run(() => bad(400));
    expect(await screen.findByText(MSG)).toBeTruthy();
    expect(screen.queryByText(/Applied \d/)).toBeNull();
  });
  it('an empty-body 500 shows a plain sentence, not "Apply failed" or a parse error', async () => {
    await run(empty500);
    expect(await screen.findByText('Could not apply the package - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
    expect((screen.getByRole('button', { name: /apply package/i }) as HTMLButtonElement).disabled).toBe(false);
  });
  it('a 200 reports the result', async () => {
    await run(() => ok({ inserted: 2, ended: 1 }));
    expect(await screen.findByText(/Applied 2 components/)).toBeTruthy();
  });
});

describe('TopCustomersWidget', () => {
  const load = async () => {
    vi.resetModules();
    const { TopCustomersWidget } = await import('@/components/dashboard/widgets/TopCustomersWidget');
    render(<TopCustomersWidget />);
  };
  it('a 400 shows the server message', async () => {
    route(() => bad(400)); await load();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('an empty-body 500 shows a plain sentence', async () => {
    route(() => empty500()); await load();
    expect(await screen.findByText('Could not load top customers - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a 200 lists the customers', async () => {
    route(() => ok([{ clientId: 'c1', clientName: 'D2 Customer', totalInvoiced: 500, balance: 0 }])); await load();
    expect(await screen.findByText('D2 Customer')).toBeTruthy();
  });
});

describe('loans list', () => {
  it('a failing components check is said, while the loans still list', async () => {
    route((u) => (u.includes('/components') ? empty500() : ok([{ id: 'l1', employeeId: 'e', loanNumber: 'LN-D2', description: 'd', principal: 1, outstandingBalance: 1, annualInterestRate: 0, termMonths: 1, method: 'interest_free', status: 'active', startDate: '2026-01-01' }])));
    render(<LoansListPage />);
    expect(await screen.findByText('Could not check the loan payslip components - try again')).toBeTruthy();
    expect(screen.getByText('LN-D2')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
});

describe('bank feeds', () => {
  it('a refused bank-accounts list shows the server message', async () => {
    route((u) => (u.includes('bank-accounts') ? bad(403) : ok({ items: [] })));
    render(<BankFeedsPage />);
    await waitFor(() => expect(toasts()).toContain(MSG));
  });
  it('an empty-body 500 shows a plain sentence', async () => {
    route((u) => (u.includes('bank-accounts') ? empty500() : ok({ items: [] })));
    render(<BankFeedsPage />);
    await waitFor(() => expect(toasts()).toContain('Could not load the bank accounts - try again'));
    expect(noRawText()).toBe(true);
  });
});

describe('compliance report', () => {
  it('a failing users list is logged and the report still loads', async () => {
    route((u) => (u.includes('/users') ? empty500() : ok([{ userId: 'u-9', expectedDays: 5, submittedDays: 5, missingDays: [], status: 'compliant' }])));
    render(<CompliancePage />);
    expect(await screen.findByText('u-9')).toBeTruthy();
    await waitFor(() => expect(log.warn).toHaveBeenCalled());
  });
});

describe('command palette', () => {
  const search = async () => {
    render(<CommandPalette isOpen onClose={() => undefined} />);
    fireEvent.change(screen.getByPlaceholderText('Search or jump to...'), { target: { value: 'acme' } });
  };
  it('a failing search says so instead of "No results"', async () => {
    route((u) => (u.includes('q=acme') ? empty500() : ok({ results: [], actions: [] })));
    await search();
    expect(await screen.findByText('Could not search - try again')).toBeTruthy();
    expect(screen.queryByText(/No results for/)).toBeNull();
  });
  it('a refused search shows the server message', async () => {
    route((u) => (u.includes('q=acme') ? bad(403) : ok({ results: [], actions: [] })));
    await search();
    expect(await screen.findByText(MSG)).toBeTruthy();
  });
  it('a 200 with no hits still says "No results"', async () => {
    route(() => ok({ results: [], actions: [] }));
    await search();
    expect(await screen.findByText(/No results for/)).toBeTruthy();
  });
});

describe('external migration wizard', () => {
  const ACC = { data: { parsed: [{ code: '1', name: 'Cash', openingBalance: 0, mappedType: 'asset' }] } };
  const toMapping = async (handler: (u: string) => Response) => {
    route((u) => handler(u));
    render(<ExternalMigrationWizard source="xero" onDone={() => undefined} onBack={() => undefined} />);
  };
  const parsed = () => new Response(JSON.stringify({ success: true, ...ACC }), { status: 200 });
  it('a failed parse shows a plain sentence, not "Parse failed"', async () => {
    await toMapping(() => empty500());
    fireEvent.click(screen.getByText('upload Chart of Accounts'));
    expect(await screen.findByText('Could not parse file - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('auto-map runs in memory: no request, no error, and the accounts stay', async () => {
    // It used to POST JSON.stringify(accounts) to the CSV parser, which found no
    // CSV rows and the wizard replaced the whole account list with [].
    let posts = 0;
    await toMapping(() => (++posts === 1 ? parsed() : empty500()));
    fireEvent.click(screen.getByText('upload Chart of Accounts'));
    await waitFor(() => expect((screen.getByText(/Next: Map Accounts/).closest('button') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText(/Next: Map Accounts/));
    fireEvent.click(await screen.findByText('auto-map'));
    expect(posts).toBe(1);
    expect(screen.queryByText(/Could not/)).toBeNull();
    fireEvent.click(screen.getByText(/Next: Review/));
    expect(await screen.findByText('Ready to import')).toBeTruthy();
    expect(screen.getByText('Accounts').parentElement?.textContent).toContain('1');
  });
  it('a failed import shows a plain sentence', async () => {
    let posts = 0;
    await toMapping(() => (++posts === 1 ? parsed() : empty500()));
    fireEvent.click(screen.getByText('upload Chart of Accounts'));
    await waitFor(() => expect((screen.getByText(/Next: Map Accounts/).closest('button') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByText(/Next: Map Accounts/));
    fireEvent.click(await screen.findByText(/Next: Review/));
    fireEvent.click(await screen.findByText('Import Now'));
    expect(await screen.findByText('Could not import the data - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
});
