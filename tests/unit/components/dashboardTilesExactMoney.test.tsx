/**
 * Home tiles show the exact amount ("R 11 009 575.43"), never the compact
 * abbreviation ("R 11.0M"): a tile is a figure someone reconciles against the
 * report it summarises (principle 1, spec §4 H).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LayoutDashboard } from 'lucide-react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true }) }));

import { apiFetch } from '@/lib/apiFetch';
import { formatMoney } from '@/lib/money/formatMoney';
import { DashboardHero } from '@/components/accounting/dashboard/DashboardHero';
import { OverviewKpiCards } from '@/components/accounting/dashboard/OverviewKpiCards';
import { WorkbenchSection } from '@/components/accounting/dashboard/WorkbenchSection';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const BIG = 11009575.43;
const COMPACT = /\d\.\d\s?[MK]\b/;
/** formatMoney's text as getByText sees it: the matcher normalises the DOM's NBSP to a space. */
const exact = (n: number): string => formatMoney(n).replace(/\s/g, ' ');

describe('dashboard tiles show exact amounts', () => {
  it('hero pills', () => {
    const { container } = render(
      <DashboardHero
        companyName="Demo" activeTab="overview" onTabChange={() => {}}
        tabs={[{ id: 'overview', label: 'Overview', icon: LayoutDashboard }]}
        stats={{ revenueMtd: BIG, outstandingInvoices: 2345678.9, cashPosition: -1500000 }}
      />,
    );
    expect(screen.getByText(exact(BIG))).toBeTruthy();
    expect(screen.getByText(exact(2345678.9))).toBeTruthy();
    expect(container.textContent).not.toMatch(COMPACT);
  });

  it('KPI cards', () => {
    const { container } = render(<OverviewKpiCards kpis={{
      revenue: { total: BIG, priorTotal: 0, changePercent: 3 },
      grossProfit: { amount: 4321098.76, margin: 40 },
      cash: { total: 1234567.89, priorTotal: 0, change: 98765.43 },
      receivables: { total: 10686885.43, overdue: 10500000.01, avgDebtorDays: 40 },
    }} />);
    expect(screen.getByText(exact(BIG))).toBeTruthy();
    expect(screen.getByText(exact(10686885.43))).toBeTruthy();
    expect(screen.getByText(`${exact(10500000.01)} overdue`)).toBeTruthy();
    expect(container.textContent).not.toMatch(COMPACT);
  });

  it('Outstanding AR shows the disputed share of the overdue figure, only when there is one', () => {
    const kpis = (overdueDisputed: number) => ({
      revenue: { total: 0, priorTotal: 0, changePercent: 0 },
      grossProfit: { amount: 0, margin: 0 },
      cash: { total: 0, priorTotal: 0, change: 0 },
      receivables: { total: 1500, overdue: 1000, overdueDisputed, avgDebtorDays: 40 },
    });
    const { unmount } = render(<OverviewKpiCards kpis={kpis(250)} />);
    expect(screen.getByText(`${exact(1000)} overdue`)).toBeTruthy();
    expect(screen.getByText(`of which ${exact(250)} disputed`)).toBeTruthy();
    unmount();
    render(<OverviewKpiCards kpis={kpis(0)} />);
    expect(screen.queryByText(/disputed/)).toBeNull();
  });

  it('workbench VAT estimate', async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response(JSON.stringify({ success: true, data: {
      unreconciledBankTxns: 0, draftInvoices: 0, apDueThisWeek: 0, unpostedJournals: 0,
      openPriorPeriods: 0, vatEstimateCurrentPeriod: 1234567.89,
    } }), { status: 200 }));
    const { container } = render(<WorkbenchSection />);
    expect(await screen.findByText(exact(1234567.89))).toBeTruthy();
    expect(container.textContent).not.toMatch(COMPACT);
  });
});
