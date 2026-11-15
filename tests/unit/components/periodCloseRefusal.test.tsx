/**
 * A close the readiness gate refuses shows WHICH checks failed and where to fix
 * them (Hein, 2026-11-15), on every close screen: the Fiscal Periods tab's Close
 * and Bulk Close, and the Financial Years page's Close and Close Year. The real
 * apiFetch contract runs (it resolves on 4xx), so each screen has to read the
 * 409 itself.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/contexts/CompanyContext', () => ({ useCompany: () => ({ activeCompany: { id: 'co-1' } }) }));
vi.mock('@/components/accounting/fiscal-periods/CloseReadinessChecklist', () => ({ CloseReadinessChecklist: () => null }));
vi.mock('@/components/accounting/fiscal-periods/BulkConfirmModal', () => ({
  BulkConfirmModal: ({ onConfirm }: { onConfirm: () => void }) => <button onClick={onConfirm}>confirm bulk</button>,
}));

import { apiFetch } from '@/lib/apiFetch';
import { FiscalPeriodsTab } from '../../../src/components/accounting/dashboard/FiscalPeriodsTab';
import FinancialYearsPage from '../../../pages/accounting/financial-years/index';

useApiJsonOverMock();
afterEach(() => { cleanup(); });

const period = (id: string, n: number, name: string) => ({
  id, periodName: name, periodNumber: n, fiscalYear: 2026, startDate: `2026-0${n}-01`, endDate: `2026-0${n}-28`,
  status: 'open', createdAt: '2026-01-01', updatedAt: '2026-01-01',
});
const JAN = period('p1', 1, 'January 2026');
const FEB = period('p2', 2, 'February 2026');
const YEAR = { id: 'y1', fiscalYear: 2026, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', kind: 'normal', stored: true, months: 12, periods: [JAN, FEB] };

const BANK = { key: 'bank_reconciled', label: 'Bank reconciled', reason: '1 unreconciled bank transaction remains in this period.', fixHref: '/accounting/bank-transactions' };
const DRAFTS = { key: 'unposted_journals', label: 'Unposted journals', reason: '2 journal entries are still in draft.', fixHref: '/accounting/journal-entries' };

const ok = (data: unknown) => new Response(JSON.stringify({ success: true, data }), { status: 200 });
const notReady = (message: string, details: Record<string, unknown>) => new Response(JSON.stringify({
  success: false, error: { code: 'CONFLICT', message, details: { code: 'PERIOD_CLOSE_NOT_READY', ...details } },
}), { status: 409 });

/** Every POST to fiscal-periods-action is answered by `write`; every GET loads the two periods. */
function script(write: (body: Record<string, unknown>) => Response) {
  vi.mocked(apiFetch).mockReset().mockImplementation(async (url, init) => {
    const u = String(url);
    if ((init?.method ?? 'GET').toUpperCase() === 'POST' && u.includes('fiscal-periods-action')) {
      return write(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
    }
    if (u.includes('jeCounts')) return ok({});
    if (u.includes('/fiscal-years')) return ok([YEAR]);
    return ok([JAN, FEB]);
  });
}

/** The refusal panel shows the period, each check's label and reason, and a Fix link to its screen. */
function expectBlockers(panel: HTMLElement, periodName: string, checks: Array<typeof BANK>) {
  const scope = within(panel);
  expect(scope.getByText(periodName)).toBeTruthy();
  for (const c of checks) {
    expect(scope.getByText(c.label)).toBeTruthy();
    expect(scope.getByText(c.reason)).toBeTruthy();
  }
  const hrefs = scope.getAllByRole('link', { name: /fix/i }).map((a) => a.getAttribute('href'));
  for (const c of checks) expect(hrefs).toContain(c.fixHref);
}

const GENERIC = 'Could not update the fiscal period - try again';
const ONE_PERIOD = { periods: [{ periodId: 'p1', periodName: 'January 2026', blockers: [BANK, DRAFTS] }] };

describe('Fiscal Periods tab', () => {
  it('Close: a 409 lists the failing checks with Fix links, not a generic error', async () => {
    script(() => notReady('January 2026 cannot be closed — 2 checks did not pass', ONE_PERIOD));
    render(<FiscalPeriodsTab />);
    await screen.findByText('January 2026');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Close period' }));
    const panel = await screen.findByTestId('close-refusal');
    expect(within(panel).getByText(/January 2026 cannot be closed/)).toBeTruthy();
    expectBlockers(panel, 'January 2026', [BANK, DRAFTS]);
    expect(screen.queryByText(GENERIC)).toBeNull();
  });

  it('Bulk Close: each refused period lists its failing checks', async () => {
    script(() => ok({
      okCount: 1, total: 2,
      results: [
        { id: 'p1', ok: true },
        { id: 'p2', ok: false, error: 'February 2026 cannot be closed', code: 'PERIOD_CLOSE_NOT_READY',
          periods: [{ periodId: 'p2', periodName: 'February 2026', blockers: [BANK] }] },
      ],
    }));
    render(<FiscalPeriodsTab />);
    await screen.findByText('February 2026');
    fireEvent.click(screen.getByLabelText('Select all periods'));
    fireEvent.click(screen.getByRole('button', { name: /^Close \(2\)/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'confirm bulk' }));
    const panel = await screen.findByTestId('close-refusal');
    expectBlockers(panel, 'February 2026', [BANK]);
  });

  it('Dismiss clears the panel', async () => {
    script(() => notReady('January 2026 cannot be closed', ONE_PERIOD));
    render(<FiscalPeriodsTab />);
    await screen.findByText('January 2026');
    fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Close period' }));
    const panel = await screen.findByTestId('close-refusal');
    fireEvent.click(within(panel).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('close-refusal')).toBeNull();
  });
});

describe('Financial Years page', () => {
  it('Close: a 409 lists the failing checks with Fix links', async () => {
    script(() => notReady('January 2026 cannot be closed', ONE_PERIOD));
    render(<FinancialYearsPage />);
    await screen.findByText('FY 2026');
    fireEvent.click((await screen.findAllByRole('button', { name: 'Close' }))[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Close period' }));
    expectBlockers(await screen.findByTestId('close-refusal'), 'January 2026', [BANK, DRAFTS]);
    expect(screen.queryByText('Could not update that period - try again')).toBeNull();
  });

  it('Close Year: a 409 names every failing period and its checks; nothing closed', async () => {
    script(() => notReady('Fiscal year 2026 cannot be closed', {
      fiscalYear: 2026,
      periods: [
        { periodId: 'p1', periodName: 'January 2026', blockers: [BANK] },
        { periodId: 'p2', periodName: 'February 2026', blockers: [DRAFTS] },
      ],
    }));
    render(<FinancialYearsPage />);
    fireEvent.click(await screen.findByRole('button', { name: /close year/i }));
    fireEvent.click((await screen.findAllByRole('button', { name: /close year/i })).at(-1)!);
    const panel = await screen.findByTestId('close-refusal');
    expect(within(panel).getByText(/FY 2026 cannot be closed/)).toBeTruthy();
    expectBlockers(panel, 'January 2026', [BANK]);
    expectBlockers(panel, 'February 2026', [DRAFTS]);
    expect(screen.queryByText('Could not close the year - try again')).toBeNull();
  });
});
