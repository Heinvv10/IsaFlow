/**
 * A headline figure that did not load is a dash with a Retry, never R 0.00 or 0
 * (audit b.1): a zero reads as "nothing owed / nothing to do", which a failed
 * load cannot know. Covers the KPI cards, the "Today in the books" cards, the
 * Action Items and /home.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('next/router', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/hooks/useVatRegistration', () => ({ useVatRegistration: () => ({ isRegistered: true }) }));
vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/contexts/CompanyContext', () => ({
  useCompany: () => ({ activeCompany: { id: 'co-1', name: 'Demo' }, companies: [], loading: false, companyRole: 'owner', switchCompany: vi.fn() }),
}));
const apiFetch = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetch(...a),
  assertOk: async (res: Response, fallback: string) => { if (!res.ok) throw new Error(fallback); },
  apiErrorMessage: (_e: unknown, fallback: string) => fallback,
}));

import { OverviewKpiCards } from '@/components/accounting/dashboard/OverviewKpiCards';
import { WorkbenchSection } from '@/components/accounting/dashboard/WorkbenchSection';
import { TodoWidget } from '@/components/accounting/dashboard/TodoWidget';
import HomePage from '../../../pages/home';

const fail500 = () => new Response('', { status: 500 });
const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const ZERO_RAND = /R\s?0[.,]00/;
const calls = (needle: string) => apiFetch.mock.calls.filter(([u]) => String(u).includes(needle)).length;

beforeEach(() => { apiFetch.mockReset(); });
afterEach(cleanup);

describe('KPI cards with no figures', () => {
  it('show the placeholder, no R 0.00, no "No overdue", and a Retry that calls back', () => {
    const onRetry = vi.fn();
    const { container } = render(<OverviewKpiCards kpis={undefined} headline={undefined} onRetry={onRetry} />);
    expect(container.textContent).not.toMatch(ZERO_RAND);
    expect(screen.queryByText(/No overdue/)).toBeNull();
    expect(screen.queryByText(/vs prior period/)).toBeNull();
    expect(screen.queryByText(/change/)).toBeNull();
    for (const title of ['Revenue', 'Net Profit', 'Cash', 'Receivables']) expect(screen.getByText(title)).toBeTruthy();
    expect(container.querySelectorAll('span.tabular-nums').length).toBe(4);
    // A screen reader hears why each card has no figure.
    expect(screen.getAllByText('not loaded')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('with only the kpis loaded (no headline) still show no figure', () => {
    const { container } = render(<OverviewKpiCards
      kpis={{ revenue: { total: 0, priorTotal: 0, changePercent: 0 }, netProfit: { amount: 0, margin: null },
        receivables: { total: 0, overdue: 0, avgDebtorDays: 0 } }}
      headline={undefined}
    />);
    expect(container.textContent).not.toMatch(ZERO_RAND);
  });
});

describe('Today in the books on a 500', () => {
  it('shows no 0 count, and Retry fetches again and then shows the figures', async () => {
    apiFetch.mockResolvedValueOnce(fail500());
    const { container } = render(<WorkbenchSection />);
    expect(await screen.findByText('Could not load workbench metrics')).toBeTruthy();
    const values = [...container.querySelectorAll('a p.font-bold')].map((p) => p.textContent);
    expect(values.length).toBe(6);
    for (const v of values) expect(v).not.toMatch(/\d/);
    apiFetch.mockResolvedValueOnce(ok({
      unreconciledBankTxns: 0, draftInvoices: 7, apDueThisWeek: 2, unpostedJournals: 3, openPriorPeriods: 0, vatEstimateCurrentPeriod: 0,
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('7')).toBeTruthy();
    expect(calls('dashboard/workbench')).toBe(2);
    expect(screen.queryByText('Could not load workbench metrics')).toBeNull();
    expect(screen.getByText('Bills due in 7 days')).toBeTruthy();
    expect(screen.getByText('Draft journals')).toBeTruthy();
  });
});

describe('Action Items on a 500', () => {
  it('Retry fetches again', async () => {
    apiFetch.mockResolvedValueOnce(fail500());
    render(<TodoWidget />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls('dashboard-todos')).toBe(2));
  });
});

describe('/home on a 500', () => {
  it('Retry fetches /api/home again', async () => {
    apiFetch.mockResolvedValueOnce(fail500());
    render(<HomePage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(calls('/api/home')).toBe(2));
  });
});
