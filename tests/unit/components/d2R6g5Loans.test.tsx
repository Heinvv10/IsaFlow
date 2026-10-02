/**
 * D2 round 6 (g5): accounting loan detail (events reload clears stale rows, a tab error does not follow you to
 * another tab, plain load sentence) and payroll loan detail (load and close failures say what failed, never a
 * thrown rejection, never HTTP codes). REAL assertOk / apiErrorMessage over the scripted apiFetch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { MSG, bad, empty500, noRawText, ok, route, spinning } from '../helpers/d2R3a1Serve';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/link', () => ({ default: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: { id: 'loan-1' }, push: vi.fn() }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/loans/LoanStatusBadge', () => ({ LoanStatusBadge: () => null }));
vi.mock('@/components/loans/LoanOverviewTab', () => ({ LoanOverviewTab: () => <div>overview</div> }));
vi.mock('@/components/loans/LoanScheduleTab', () => ({ LoanScheduleTab: ({ rows }: { rows: unknown[] }) => <div>SCHEDULE {rows.length} rows</div> }));
vi.mock('@/components/loans/LoanEventsTab', () => ({
  LoanEventsTab: ({ events, onRefresh }: { events: unknown[]; onRefresh: () => void }) => (
    <div>EVENTS {events.length}<button onClick={onRefresh}>REFRESH EVENTS</button></div>
  ),
}));
vi.mock('@/components/loans/LoanComplianceTab', () => ({ LoanComplianceTab: () => null }));
vi.mock('@/components/loans/LoanRateCurveTab', () => ({ LoanRateCurveTab: () => <div>CURVE TAB</div> }));

import AccountingLoanPage from '../../../pages/accounting/loans/[id]';
import PayrollLoanPage from '../../../pages/payroll/loans/[id]';

configure({ asyncUtilTimeout: 4000 });
useApiJsonOverMock();
beforeEach(() => { vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

describe('accounting loan detail', () => {
  const LOAN = { id: 'loan-1', reference: 'LN-D2-1', status: 'active', product: null, description: null, curveId: null };
  const tab = async (name: string) => fireEvent.click(await screen.findByRole('button', { name }));

  it('an events reload that fails clears the old events and says why', async () => {
    let events = 0;
    route((url) => {
      if (url.includes('/events')) { events += 1; return events === 1 ? ok([{ id: 'e1' }, { id: 'e2' }]) : bad(); }
      return ok(LOAN);
    });
    render(<AccountingLoanPage />);
    await tab('Events');
    expect(await screen.findByText(/EVENTS 2/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'REFRESH EVENTS' }));
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.getByText(/EVENTS 0/)).toBeTruthy();
  });
  it('a failed events load shows a plain sentence, no HTTP codes', async () => {
    route((url) => (url.includes('/events') ? empty500() : ok(LOAN)));
    render(<AccountingLoanPage />);
    await tab('Events');
    expect(await screen.findByText('Could not load the loan events - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('the Events error does not follow you onto a Rate Curve tab that has no curve', async () => {
    route((url) => (url.includes('/events') ? bad() : ok(LOAN)));
    render(<AccountingLoanPage />);
    await tab('Events');
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    await tab('Rate Curve');
    await screen.findByText('CURVE TAB');
    expect(screen.queryByText(new RegExp(MSG))).toBeNull();
  });
  it('a failed schedule load shows a plain sentence and no rows', async () => {
    route((url) => (url.includes('/schedule') ? empty500() : ok(LOAN)));
    render(<AccountingLoanPage />);
    await tab('Schedule');
    expect(await screen.findByText('Could not load the repayment schedule - try again')).toBeTruthy();
    expect(screen.getByText(/SCHEDULE 0 rows/)).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a failed loan load says so in a plain sentence', async () => {
    route(() => empty500());
    render(<AccountingLoanPage />);
    expect(await screen.findByText('Could not load the loan - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a refused loan load shows the server message', async () => {
    route(() => bad());
    render(<AccountingLoanPage />);
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
  });
});

describe('payroll loan detail', () => {
  const PAYROLL_LOAN = { id: 'loan-1', loanNumber: 'PL-1', description: 'D2 staff loan', employeeId: 'e1', principal: 1000, annualInterestRate: 0.1,
    termMonths: 12, method: 'declining_balance', status: 'active', outstandingBalance: 900, totalInterestCharged: 10, totalPrincipalPaid: 100,
    startDate: '2026-01-01', firstPeriodYear: 2026, firstPeriodMonth: 1 };
  const detail = () => ok({ loan: PAYROLL_LOAN, schedule: [], payments: [] });
  const settle = async () => {
    vi.stubGlobal('confirm', () => true);
    fireEvent.click(await screen.findByRole('button', { name: /Settle/ }));
  };

  it('a failed load shows a plain sentence, no stale loan, no spinner', async () => {
    route(() => empty500());
    render(<PayrollLoanPage />);
    expect(await screen.findByText('Could not load the loan - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
    await waitFor(() => expect(spinning()).toBe(false));
  });
  it('a refused close keeps the loan on screen and shows the server message', async () => {
    route((_u, method) => (method === 'POST' ? bad() : detail()));
    render(<PayrollLoanPage />);
    await settle();
    expect(await screen.findByText(new RegExp(MSG))).toBeTruthy();
    expect(screen.getByText(/PL-1/)).toBeTruthy();
  });
  it('an empty-500 close shows a plain sentence naming the action', async () => {
    route((_u, method) => (method === 'POST' ? empty500() : detail()));
    render(<PayrollLoanPage />);
    await settle();
    expect(await screen.findByText('Could not settle the loan - try again')).toBeTruthy();
    expect(noRawText()).toBe(true);
  });
  it('a dropped connection during the close shows the sentence instead of an unhandled rejection', async () => {
    vi.mocked(apiFetch).mockReset().mockImplementation(async (_url, init) => {
      if ((init?.method ?? 'GET').toUpperCase() === 'POST') throw new TypeError('Failed to fetch');
      return detail();
    });
    render(<PayrollLoanPage />);
    await settle();
    expect(await screen.findByText('Could not settle the loan - try again')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Failed to fetch/);
  });
  it('a good close reloads the loan', async () => {
    let gets = 0;
    route((_u, method) => { if (method === 'POST') return ok({}); gets += 1; return detail(); });
    render(<PayrollLoanPage />);
    await settle();
    await waitFor(() => expect(gets).toBe(2));
    expect(await screen.findByText(/PL-1/)).toBeTruthy();
  });
});
