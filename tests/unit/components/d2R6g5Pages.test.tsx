/**
 * D2 round 6 (g5): admin companies list, PAYG tenants, three-way forecast, UIF declarations, tax directives.
 * A failed reload clears the stale rows (and the bulk selection); a refused write shows the server message; an
 * empty-body 500 or a dropped connection shows a plain sentence naming the action. REAL assertOk / apiErrorMessage.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, push: vi.fn(), replace: vi.fn(), pathname: '/' }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/admin/AdminLayout', () => ({ AdminLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/hooks/useAdminPrefix', () => ({ useAdminHref: () => (p: string) => p }));
vi.mock('@/components/accounting/DataQualityNotice', () => ({ DataQualityNotice: () => null }));

import CompaniesPage from '../../../pages/admin/companies/index';
import PaygPage from '../../../pages/admin/billing/payg';
import ForecastPage from '../../../pages/accounting/reports/three-way-forecast';
import UifPage from '../../../pages/payroll/uif/index';
import TaxDirectivesPage from '../../../pages/payroll/tax-directives/index';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('admin companies list', () => {
  const C = { id: 'c-1', name: 'D2 Acme Ltd', trading_name: null, plan_name: 'Starter', plan_code: 'starter', status: 'active', user_count: 1, mrr_cents: 0, created_at: '2026-01-01T00:00:00Z', last_active: null };
  it('a failed reload clears the rows, the total and the bulk selection', async () => {
    let gets = 0;
    route(() => { gets += 1; return gets === 1 ? ok({ items: [C], total: 1, page: 1, limit: 25 }) : empty500(); });
    render(<CompaniesPage />);
    expect(await screen.findByText('D2 Acme Ltd')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('checkbox')[1]!);
    expect(await screen.findByRole('button', { name: /suspend/i })).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search companies...'), { target: { value: 'zzz' } });
    expect(await screen.findByText('Could not load companies - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Acme Ltd')).toBeNull();
    expect(screen.queryByRole('button', { name: /suspend/i })).toBeNull();
    expect(noRawText()).toBe(true);
  });
});

describe('PAYG tenants', () => {
  const T = { companyId: 'p-1', companyName: 'D2 Payg Co', balance: 5, autoTopupEnabled: false, nudgeLevel: 'none', monthFlowsUsed: 1, monthResetAt: '2026-02-01', monthDebitedCents: 100 };
  const list = () => ok({ companies: [T] });
  let alerts: string[] = [];
  const adjust = async () => {
    alerts = [];
    vi.stubGlobal('prompt', vi.fn().mockReturnValueOnce('5').mockReturnValueOnce('D2 reason'));
    vi.stubGlobal('alert', (m: string) => { alerts.push(m); });
    fireEvent.click(await screen.findByRole('button', { name: 'Adjust' }));
  };
  it('a failed load clears the tenants', async () => {
    let gets = 0;
    route(() => { gets += 1; return gets === 1 ? list() : empty500(); });
    render(<PaygPage />);
    expect(await screen.findByText('D2 Payg Co')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Search company name...'), { target: { value: 'x' } });
    expect(await screen.findByText('Could not load PAYG companies - try again')).toBeTruthy();
    expect(screen.queryByText('D2 Payg Co')).toBeNull();
  });
  it('a refused adjustment alerts the server message', async () => {
    route((_u, m) => (m === 'POST' ? bad() : list()));
    render(<PaygPage />);
    await adjust();
    await waitFor(() => expect(alerts).toEqual([MSG]));
  });
  it('an empty-500 adjustment alerts a plain sentence', async () => {
    route((_u, m) => (m === 'POST' ? empty500() : list()));
    render(<PaygPage />);
    await adjust();
    await waitFor(() => expect(alerts).toEqual(['Could not adjust the wallet - try again']));
  });
  it('a dropped connection alerts the sentence instead of an unhandled rejection', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_u, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') throw new TypeError('Failed to fetch');
      return list();
    });
    render(<PaygPage />);
    await adjust();
    await waitFor(() => expect(alerts).toEqual(['Could not adjust the wallet - try again']));
  });
});

describe('three-way forecast', () => {
  const FORECAST = { forecast: { months: [], params: { revenueGrowthRate: 0, costOfSalesGrowthRate: 0, opexGrowthRate: 0, capitalExpenditure: 0 }, generatedAt: 'x' }, unclassifiedAccounts: null };
  const run = async () => fireEvent.click(await screen.findByRole('button', { name: /Run Forecast/ }));
  it('a refused run shows the server message', async () => {
    route(() => bad());
    render(<ForecastPage />);
    await run();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });
  it('an empty-500 run shows a plain sentence, never nothing', async () => {
    route(() => empty500());
    render(<ForecastPage />);
    await run();
    expect(await screen.findByText('Could not run the forecast - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a good run shows no error, and a later failing run clears the old forecast', async () => {
    let n = 0;
    route(() => { n += 1; return n === 1 ? ok(FORECAST) : empty500(); });
    render(<ForecastPage />);
    await run();
    await waitFor(() => expect(n).toBe(1));
    await waitFor(() => expect(document.body.textContent).toMatch(/Revenue|Net Profit|P&L/));
    expect(screen.queryByText('Could not run the forecast - try again')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Run Forecast/ }));
    expect(await screen.findByText('Could not run the forecast - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Net Profit/);
  });
});

describe('UIF declarations', () => {
  const D = { id: 'u-1', periodYear: 2026, periodMonth: 1, totalEmployees: 2, totalLeviableSalary: 100, totalEmployeeContribution: 1, totalEmployerContribution: 1, totalUif: 2, status: 'draft', submittedAt: null };
  const mark = async () => fireEvent.click(await screen.findByRole('button', { name: /Mark Submitted/ }));
  it('a refused mark-submitted shows the server message and keeps the table', async () => {
    route((_u, m) => (m === 'PATCH' ? bad() : ok([D])));
    render(<UifPage />);
    await mark();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.getByRole('button', { name: /Mark Submitted/ })).toBeTruthy();
  });
  it('an empty-500 mark-submitted shows a plain sentence (it used to do nothing)', async () => {
    route((_u, m) => (m === 'PATCH' ? empty500() : ok([D])));
    render(<UifPage />);
    await mark();
    expect(await screen.findByText('Could not mark the declaration as submitted - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a failed load shows a plain sentence', async () => {
    route(() => empty500());
    render(<UifPage />);
    expect(await screen.findByText('Could not load the UIF declarations - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
});

describe('tax directives', () => {
  const D = { id: 't-1', employeeName: 'D2 Employee', employeeTaxNumber: null, directiveType: 'lump_sum', amount: 100, taxRate: null, effectiveDate: '2026-01-01', status: 'pending' };
  const approve = async () => fireEvent.click(await screen.findByRole('button', { name: 'Approve' }));
  it('a refused status change reverts the row and says why', async () => {
    route((_u, m) => (m === 'PATCH' ? bad() : ok([D])));
    render(<TaxDirectivesPage />);
    await approve();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
  });
  it('an empty-500 status change shows a plain sentence', async () => {
    route((_u, m) => (m === 'PATCH' ? empty500() : ok([D])));
    render(<TaxDirectivesPage />);
    await approve();
    expect(await screen.findByText('Could not update the directive status - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
});
