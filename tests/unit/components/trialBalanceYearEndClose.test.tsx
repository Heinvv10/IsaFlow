/**
 * D4: the trial balance page names the derived year-end close on a period that
 * crosses a fiscal-year start — on each affected row and in a note under the
 * table — so opening + movement ≠ closing is explained, as the account-detail
 * page explains it. Inside one fiscal year nothing extra renders.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <>{children}</> }));
vi.mock('@/components/accounting/evidence/EvidenceDrillModal', () => ({ EvidenceDrillModal: () => null }));
vi.mock('@/contexts/TableDensityContext', () => ({ useTableDensity: () => ({ rowClass: '' }) }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true }) }));
vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
useApiJsonOverMock();
import { apiFetch } from '@/lib/apiFetch';
import TrialBalancePage from '@/../pages/accounting/trial-balance';

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const tbRow = (accountCode: string, accountName: string, accountType: string, debitBalance: number, closedToRetainedEarnings: number, derived?: boolean) => ({
  accountCode, accountName, accountType, normalBalance: accountType === 'expense' ? 'debit' : 'credit',
  debitBalance, creditBalance: 0, closedToRetainedEarnings, ...(derived ? { derived } : {}),
});

function serve(report: Record<string, unknown>) {
  vi.mocked(apiFetch).mockImplementation(async (url) => {
    const data = String(url).includes('fiscal-periods')
      ? [{ id: 'period', periodName: 'FY26', startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' }]
      : String(url).includes('reports-trial-balance')
        ? { totalDebit: 0, totalCredit: 0, difference: 0, balanced: true, accountCount: 2, fiscalYearStart: '2026-03-01', ...report }
        : [];
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
}

describe('trial balance page — derived year-end close', () => {
  it('labels the close on each affected row and explains it under the table', async () => {
    serve({
      fiscalYearEndsClosed: ['2026-02-28'],
      rows: [tbRow('5200', 'Labour', 'expense', 250, -1300), tbRow('RE-BF', 'Retained Earnings b/f', 'equity', 1207, -1200, true)],
    });
    render(<TrialBalancePage />);
    expect(await screen.findByText(/net R\s?1\s?300,00 closed to retained earnings — derived, not posted/)).toBeTruthy();
    expect(screen.getByText(/includes fiscal years closed in this period: net R\s?1\s?200,00 loss/)).toBeTruthy();
    const note = screen.getByRole('note');
    expect(note.textContent).toContain('fiscal year end 2026-02-28');
    expect(note.textContent).toMatch(/net R\s?1\s?200,00 loss/);
    expect(note.textContent).toContain('opening + movement + year-end close = closing');
  });

  it('shows nothing extra when the period sits inside one fiscal year', async () => {
    serve({ fiscalYearEndsClosed: [], rows: [tbRow('5200', 'Labour', 'expense', 250, 0)] });
    render(<TrialBalancePage />);
    expect(await screen.findByText('Labour')).toBeTruthy();
    expect(screen.queryByText(/Year-end close/)).toBeNull();
    expect(screen.queryByRole('note')).toBeNull();
  });
});
