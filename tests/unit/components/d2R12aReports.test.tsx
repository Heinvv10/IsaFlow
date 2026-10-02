/**
 * D2 round 12 (reports): a failed cost-centre / business-unit list is told to the person, not only logged;
 * a rate-limited pack reload drops the previous pack; the present deck forgets the previous range's figures
 * when its effect re-runs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { empty500, ok, on, refuse, serve } from '../helpers/d2R3a6';

const route = vi.hoisted(() => ({ query: {} as Record<string, string>, isReady: true, pathname: '/', replace: vi.fn(), push: vi.fn(async () => true) }));
const deck = vi.hoisted(() => ({ build: vi.fn() }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => route }));
vi.mock('next/link', () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ companyRole: 'owner', companyId: 'c1' }) }));
vi.mock('@/components/shared/ExportCSVButton', () => ({ ExportCSVButton: () => null }));
vi.mock('@/components/accounting/packs/PackOwnerTools', () => ({ PackShareButton: () => null, PackCommentary: () => null }));
vi.mock('@/components/accounting/reportControls/PresentLink', () => ({ PresentLink: () => null }));
vi.mock('@/components/accounting/packs/PackSectionCard', () => ({ SectionCard: () => null }));
vi.mock('@/components/accounting/present/presentSlides', () => ({ buildSlides: () => [{ id: 's1', kind: 'income', title: 'Income', data: {} }] }));
vi.mock('@/components/accounting/present/PresentDeck', () => ({
  PresentDeck: ({ slides, renderSlide }: { slides: Array<{ id: string }>; renderSlide: (s: unknown) => ReactNode }) => <div>{slides.map((s) => <div key={s.id}>{renderSlide(s)}</div>)}</div>,
}));
vi.mock('@/components/accounting/present/PresentSlide', () => ({
  PresentSlide: (p: { income: { marker?: string } | null; trends: unknown; budget: unknown[] }) =>
    <p>{`income=${p.income?.marker ?? 'none'} trends=${p.trends ? 'yes' : 'no'} budget=${p.budget.length}`}</p>,
}));

import { apiFetch } from '@/lib/apiFetch';
import BalanceSheetPage from '../../../pages/accounting/reports/balance-sheet';
import IncomeStatementPage from '../../../pages/accounting/reports/income-statement';
import CashFlowPage from '../../../pages/accounting/reports/cash-flow';
import ReportPacksPage from '../../../pages/accounting/reports/report-packs';
import PresentPackPage from '../../../pages/accounting/reports/present/[pack]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); route.query = {}; route.isReady = true; });
afterEach(() => { cleanup(); });

describe('a failed cost-centre / business-unit list is visible, and a good one is not announced', () => {
  const failing = (part: string) => serve(on('GET', part, () => refuse(`D2 ${part} are unavailable`)), on('GET', 'reports-', empty500), on('GET', 'financial-statements', empty500));
  it.each([
    ['balance sheet', 'cost-centres', () => <BalanceSheetPage />],
    ['balance sheet', 'business-units', () => <BalanceSheetPage />],
    ['income statement', 'cost-centres', () => <IncomeStatementPage />],
    ['income statement', 'business-units', () => <IncomeStatementPage />],
    ['cash flow', 'cost-centres', () => <CashFlowPage />],
  ] as const)('%s: a failed %s list shows its server message as a notice', async (_n, part, page) => {
    failing(part);
    render(page());
    const notice = await screen.findByText(`D2 ${part} are unavailable`);
    expect(notice.getAttribute('role')).toBe('alert');
  });
  it.each([
    ['balance sheet', () => <BalanceSheetPage />],
    ['income statement', () => <IncomeStatementPage />],
    ['cash flow', () => <CashFlowPage />],
  ] as const)('%s: lists that load show no notice', async (_n, page) => {
    serve(on('GET', 'cost-centres', () => ok({ items: [{ id: 'cc1', code: 'CC9', name: 'D2 Centre' }] })), on('GET', 'business-units', () => ok([])), on('GET', 'reports-', empty500));
    render(page());
    await screen.findByText(/CC9/);
    expect(document.querySelector('p[role="alert"].text-amber-500')).toBeNull();
  });
});

describe('report packs: a rate-limited reload', () => {
  it('drops the previous pack instead of showing it under the new selection', async () => {
    let limited = false;
    serve((u, m) => (m === 'GET' && u.includes('reports-pack')
      ? (limited ? new Response('', { status: 429 }) : ok({ pack: { type: 'board', companyName: 'D2 Pack Co', period: 'Sep 2026', sections: [] }, unclassifiedAccounts: null }))
      : undefined));
    render(<ReportPacksPage />);
    expect(await screen.findByText(/D2 Pack Co/)).toBeTruthy();
    limited = true;
    fireEvent.click(screen.getByText('Management Pack'));
    expect(await screen.findByText(/too many|rate|moment/i)).toBeTruthy();
    expect(screen.queryByText(/D2 Pack Co/)).toBeNull();
  });
});

describe('present deck when the range changes', () => {
  const answer = (from: string) => (u: string): Response | undefined => {
    if (u.includes('reports-pack')) return ok({ pack: { type: 'board' } });
    if (u.includes('reports-income-statement')) return from === '2026-01-01' ? ok({ marker: 'RANGE-A' }) : empty500();
    if (u.includes('reports-account-trends')) return from === '2026-01-01' ? ok({ rows: [] }) : empty500();
    if (u.includes('reports-budget-comparator')) return from === '2026-01-01' ? ok({ lines: [{ id: 'l' }], budgetedCount: 1 }) : empty500();
    return undefined;
  };
  it('the second range does not show the first range\'s income, trends or budget when its own fetches fail', async () => {
    route.query = { pack: 'board', from: '2026-01-01', to: '2026-01-31' };
    serve((u) => answer('2026-01-01')(u));
    const view = render(<PresentPackPage />);
    expect(await screen.findByText('income=RANGE-A trends=yes budget=1')).toBeTruthy();
    serve((u) => answer('2026-02-01')(u));
    route.query = { pack: 'board', from: '2026-02-01', to: '2026-02-28' };
    view.rerender(<PresentPackPage />);
    expect(await screen.findByText('income=none trends=no budget=0')).toBeTruthy();
  });
});
