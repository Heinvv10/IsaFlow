/**
 * W2 H: Home asked /api/accounting/kpi-dashboard twice per load (the hero in
 * pages/accounting/index.tsx and OverviewTab each fetched it). The page now
 * loads it once and hands the result to OverviewTab; OverviewTab rendered on
 * its own still fetches for itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/dynamic', () => ({ default: () => () => null }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'owner' }, loading: false }) }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Co' }, companies: [{ companyId: 'co-1' }], loading: false }) }));
vi.mock('@/components/accounting/dashboard/WorkbenchSection', () => ({ WorkbenchSection: () => null }));
vi.mock('@/components/accounting/dashboard/TodoWidget', () => ({ TodoWidget: () => null }));
vi.mock('@/components/accounting/dashboard/DashboardHero', () => ({
  DashboardHero: ({ stats }: { stats?: { outstandingInvoices: number } }) => <p>hero receivables {stats ? stats.outstandingInvoices : 'none'}</p>,
}));

import { apiFetch } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import AccountingPage from '../../../pages/accounting/index';
import { OverviewTab } from '@/components/accounting/dashboard/OverviewTab';
import { buildSetupProgress } from '../../../src/modules/accounting/services/core/setupProgressService';
import { ALL_FACTS } from '../helpers/setupFacts';

useApiJsonOverMock();
afterEach(cleanup);

const money = { total: 0, priorTotal: 0, changePercent: 0, overdue: 0, avgDebtorDays: 0, avgCreditorDays: 0, change: 0, amount: 0, margin: 0 };
const KPIS = {
  kpis: { revenue: money, expenses: money, grossProfit: money, netProfit: money, cash: money,
    receivables: { ...money, total: 4321 }, payables: money,
    activity: { invoicesIssued: 0, paymentsReceived: 0, journalsPosted: 0 } },
  revenueChart: [], cashFlowChart: [], arAging: [], apAging: [], topCustomers: [], topExpenses: [], hasBankAccount: true,
};
const serve = () => script((u) => (u.includes('setup-checklist') ? ok(buildSetupProgress(ALL_FACTS))
  : u.includes('kpi-dashboard') ? ok(KPIS) : ok([])));
const kpiCalls = () => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes('kpi-dashboard')).length;

describe('Home loads the dashboard figures once', () => {
  it('one kpi-dashboard request feeds the hero and the Overview tab', async () => {
    vi.mocked(apiFetch).mockClear();
    serve();
    render(<AccountingPage />);
    expect(await screen.findByText('hero receivables 4321')).toBeTruthy();
    // The Overview card shows the page's figures, not an empty load of its own.
    expect(await screen.findByText(formatMoney(4321).replace(/\s/g, ' '))).toBeTruthy();
    expect(kpiCalls()).toBe(1);
  });

  it('OverviewTab on its own still fetches the figures', async () => {
    vi.mocked(apiFetch).mockClear();
    serve();
    render(<OverviewTab />);
    expect(await screen.findByText('Outstanding AR')).toBeTruthy();
    expect(kpiCalls()).toBe(1);
  });
});
