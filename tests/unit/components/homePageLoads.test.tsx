/**
 * pages/accounting/index.tsx loads:
 *  - the KPI row's revenue line is the month-to-date figure (headline.revenueMtd), not
 *    the ~13-month revenue total kpis.revenue carries;
 *  - a kpi-dashboard response that lands after the company changed is dropped,
 *    so the old company's figures never replace the new one's;
 *  - the setup checklist is not requested until a company id exists;
 *  - with no company at all, the "No company selected" card, and nothing is asked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';

const h = vi.hoisted(() => ({
  company: { id: 'co-1' } as { id: string } | undefined,
  companiesLoading: false,
}));

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', role: 'owner' }, loading: false }) }));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({
    activeCompany: h.company ? { ...h.company, name: 'Co' } : null,
    companies: [{ companyId: 'co-1' }],
    loading: h.companiesLoading,
  }),
}));
// The tab renders the real KPI row from the page's one load, plus a plain line to match on.
vi.mock('@/components/accounting/dashboard/OverviewTab', async () => {
  const { OverviewKpiCards } = await vi.importActual<typeof import('@/components/accounting/dashboard/OverviewKpiCards')>('@/components/accounting/dashboard/OverviewKpiCards');
  type Load = { data: { headline: import('@/modules/accounting/services/reports/headlineFigures').HeadlineFigures } | null };
  return {
    OverviewTab: ({ kpiLoad }: { kpiLoad?: Load }) => {
      const hl = kpiLoad?.data?.headline;
      return <div><p>tab mtd {hl ? hl.revenueMtd : 'none'} ar {hl ? hl.receivables.total : 'none'}</p><OverviewKpiCards headline={hl} /></div>;
    },
  };
});
vi.mock('@/components/accounting/dashboard/DashboardHero', () => ({
  DashboardHero: ({ companyName }: { companyName: string }) => <p>hero {companyName}</p>,
}));

import { apiFetch } from '@/lib/apiFetch';
import AccountingPage from '../../../pages/accounting/index';
import { formatMoney } from '@/lib/money/formatMoney';
import { buildSetupProgress } from '../../../src/modules/accounting/services/core/setupProgressService';
import { ALL_FACTS } from '../helpers/setupFacts';

useApiJsonOverMock();
beforeEach(() => { h.company = { id: 'co-1' }; h.companiesLoading = false; });
afterEach(cleanup);

const money = { total: 0, priorTotal: 0, changePercent: 0, overdue: 0, avgDebtorDays: 0, avgCreditorDays: 0, change: 0, amount: 0, margin: 0 };
const kpiBody = (revenueTotal: number, revenueMtd: number, ar: number) => ({
  kpis: { revenue: { ...money, total: revenueTotal }, revenueMtd, expenses: money, grossProfit: money, netProfit: money, cash: money,
    receivables: { ...money, total: ar }, payables: money,
    activity: { invoicesIssued: 0, paymentsReceived: 0, journalsPosted: 0 } },
  revenueChart: [], cashFlowChart: [], arAging: [], apAging: [], topCustomers: [], topExpenses: [], hasBankAccount: true,
  // The KPI row reads the headline figures (reports/headlineFigures), not kpis.
  headline: { asAt: '2026-11-12', monthStart: '2026-11-01', cash: 0, receivables: { total: ar, overdue: 0 }, payables: { total: 0, overdue: 0 }, revenueMtd: revenueMtd, profitMtd: 0, draftInvoices: 0, draftBills: 0, draftJournals: 0, billsDueNext7Days: 0, billsOverdue: 0 }, period: { from: '2025-10-01', to: '2026-11-12' },
});
const setupBody = () => ok(buildSetupProgress(ALL_FACTS));
const calls = (needle: string) => vi.mocked(apiFetch).mock.calls.filter(([u]) => String(u).includes(needle)).length;

describe('Home KPI row', () => {
  it('revenue on the Profit card is the month-to-date figure, not the 13-month revenue total', async () => {
    script((u) => (u.includes('setup-checklist') ? setupBody() : u.includes('kpi-dashboard') ? ok(kpiBody(1550, 350, 9)) : ok([])));
    render(<AccountingPage />);
    const exact = (n: number) => formatMoney(n).replace(/\s/g, ' ');
    expect(await screen.findByText(`Revenue ${exact(350)} this month`)).toBeTruthy();
    expect(screen.queryByText(new RegExp(exact(1550)))).toBeNull();
  });
});

describe('kpi-dashboard response after the company changed', () => {
  it('a late answer for the old company does not replace the new company\'s figures', async () => {
    const pending: Array<(r: Response) => void> = [];
    vi.mocked(apiFetch).mockReset().mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('setup-checklist')) return setupBody();
      if (u.includes('kpi-dashboard')) return new Promise<Response>((resolve) => { pending.push(resolve); });
      return ok([]);
    });
    const view = render(<AccountingPage />);
    await waitFor(() => expect(pending).toHaveLength(1));
    h.company = { id: 'co-2' };
    view.rerender(<AccountingPage />);
    await waitFor(() => expect(pending).toHaveLength(2));
    pending[1]!(ok(kpiBody(0, 22, 222)));
    expect(await screen.findByText(/ ar 222$/)).toBeTruthy();
    // The first company's request lands last, with its own, different figures.
    pending[0]!(ok(kpiBody(0, 11, 111)));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText(/ ar 222$/)).toBeTruthy();
    expect(screen.queryByText(/ ar 111$/)).toBeNull();
  });
});

describe('setup checklist request', () => {
  it('waits for a company id, then asks once', async () => {
    script((u) => (u.includes('setup-checklist') ? setupBody() : u.includes('kpi-dashboard') ? ok(kpiBody(0, 0, 0)) : ok([])));
    h.company = undefined;
    h.companiesLoading = true;
    const view = render(<AccountingPage />);
    await new Promise((r) => setTimeout(r, 20));
    expect(calls('setup-checklist')).toBe(0);
    h.company = { id: 'co-1' };
    h.companiesLoading = false;
    view.rerender(<AccountingPage />);
    await screen.findByText(/tab mtd/);
    expect(calls('setup-checklist')).toBe(1);
  });

  it('a user with no company at all is not held on the skeleton: the No company card, and nothing is asked', async () => {
    script(() => ok([]));
    h.company = undefined;
    h.companiesLoading = false;
    render(<AccountingPage />);
    expect(await screen.findByText('No company selected')).toBeTruthy();
    expect(screen.queryByText(/hero/)).toBeNull();
    expect(calls('setup-checklist')).toBe(0);
    expect(calls('kpi-dashboard')).toBe(0);
  });
});
