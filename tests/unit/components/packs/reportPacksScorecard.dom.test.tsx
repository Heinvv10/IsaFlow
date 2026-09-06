/**
 * The interactive screen's KPI Scorecard tile.
 *
 * BROWSER REVIEW BR1 (CRITICAL): `KPIScorecardItem.value` is `number | null` —
 * null whenever the engine could not compute the ratio, which is the NORMAL
 * state for a company with non-positive equity (AN-07: every equity-divided
 * ratio is meaningless there, and scoring them 0 once rated an insolvent
 * company green). This tile was typed `value: number` and called
 * `.toFixed(2)` on it, so expanding "KPI Scorecard" on such a company threw
 * and took the whole page to the error boundary — nothing on it survived, not
 * the P&L above it or the download buttons.
 *
 * The deck and the printed page already went through the shared decision.
 * These cases pin the screen to it too.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { KPIScorecardItem } from '@/modules/accounting/services/reports/kpiScorecardService';

const useRouterMock = vi.fn();
vi.mock('next/router', () => ({ useRouter: () => useRouterMock() }));

vi.mock('@/components/layout/AppLayout', () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const apiFetchMock = vi.fn();
vi.mock('@/lib/apiFetch', () => ({
  apiFetch: (...a: unknown[]) => apiFetchMock(...a),
  assertOk: vi.fn(() => Promise.resolve({})),
}));

import ReportPacksPage from '../../../../pages/accounting/reports/report-packs';

/** Exactly what buildKPIScorecard emits for a ratio it could not compute. */
const UNSCORED: KPIScorecardItem = {
  ratioKey: 'debtToEquity',
  name: 'Debt-to-Equity',
  value: null,
  target: 0.5,
  status: 'not_meaningful',
  reason: 'Not meaningful: liabilities exceed assets',
  percentOfTarget: 0,
};

const SCORED: KPIScorecardItem = {
  ratioKey: 'currentRatio',
  name: 'Current Ratio',
  value: 2.3163,
  target: 1.5,
  status: 'green',
  percentOfTarget: 154.42,
};

function packWith(scorecard: KPIScorecardItem[]) {
  return {
    type: 'board',
    companyName: 'Brightsphere',
    period: '2026-01-01 to 2026-09-05',
    generatedAt: '2026-09-06T00:00:00.000Z',
    // KPIs first, so the card is the one SectionCard opens by default.
    sections: [{ type: 'kpis', title: 'KPI Scorecard', data: { scorecard } }],
  };
}

function respondWith(scorecard: KPIScorecardItem[]) {
  apiFetchMock.mockResolvedValue({
    json: async () => ({ data: { pack: packWith(scorecard), unclassifiedAccounts: null } }),
  });
}

beforeEach(() => {
  apiFetchMock.mockReset();
  useRouterMock.mockReset();
  // The interactive screen, not the print branch.
  useRouterMock.mockReturnValue({ isReady: true, pathname: '/accounting/reports/report-packs', query: {} });
});

describe('Report Packs screen — the KPI Scorecard tile', () => {
  it('renders an unscored KPI as its reason instead of crashing the page', async () => {
    respondWith([UNSCORED]);

    render(<ReportPacksPage />);

    // The reason is on screen — and, just as importantly, the render did not
    // throw: a throw here took the whole page to the error boundary.
    await waitFor(() => {
      expect(screen.getByText('Not meaningful: liabilities exceed assets')).toBeInTheDocument();
    });
    expect(screen.getByText('Debt-to-Equity')).toBeInTheDocument();
    // No figure invented for it: never "0.00", never "null".
    expect(screen.queryByText('0.00')).toBeNull();
  });

  it('still prints a scored KPI as value over target', async () => {
    respondWith([SCORED]);

    render(<ReportPacksPage />);

    await waitFor(() => expect(screen.getByText('2.32')).toBeInTheDocument());
    expect(screen.getByText('/ 1.5')).toBeInTheDocument();
  });

  it('shows both kinds side by side, which is what an insolvent company looks like', async () => {
    respondWith([SCORED, UNSCORED]);

    render(<ReportPacksPage />);

    await waitFor(() => expect(screen.getByText('2.32')).toBeInTheDocument());
    expect(screen.getByText('Not meaningful: liabilities exceed assets')).toBeInTheDocument();
  });

  it('falls back to a dash when the service nulls a ratio without saying why', async () => {
    const { reason: _dropped, ...noReason } = UNSCORED;
    respondWith([noReason]);

    render(<ReportPacksPage />);

    await waitFor(() => expect(screen.getByText('Debt-to-Equity')).toBeInTheDocument());
    expect(screen.getByText('–')).toBeInTheDocument();
  });
});
