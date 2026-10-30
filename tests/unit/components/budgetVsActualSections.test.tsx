/**
 * The Budget vs Actual page (budgets P3 PR-B; was P0's sections table): the
 * income-statement bands through StatementGrid, the engine's band and net-profit
 * figures copied (never summed in the page), "—" where there is no budget,
 * colour from `favourable` only (an expense over budget is unfavourable), and
 * Year to date as the default period.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { apiFetch } from '@/lib/apiFetch';
import { useApiJsonOverMock } from '../helpers/apiJsonOverMock';
import { ok, script } from '../helpers/d2R3a5';
import { trackingReport } from '../helpers/budgetTrackingReportFixture';

vi.mock('@/lib/apiFetch', async () => (await import('../helpers/apiJsonOverMock')).mockedApiFetchModule());
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('next/router', () => ({ useRouter: () => ({ query: {}, isReady: true, push: vi.fn(), replace: vi.fn(async () => true) }) }));
vi.mock('@/components/layout/AppLayout', () => ({ AppLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock('@/components/accounting/budgets/tracking/BudgetTrackingVisuals', () => ({ BudgetTrackingVisuals: () => null }));

import BudgetVsActualPage from '../../../pages/accounting/reports/budget-vs-actual';

useApiJsonOverMock();
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const REPORT = trackingReport([
  { code: '4000', name: 'Sales', type: 'revenue', actual: 1200, budget: 1000 },
  { code: '4100', name: 'Other sales', type: 'revenue', actual: 300 },
  { code: '6000', name: 'Rent', type: 'expense', actual: 800, budget: 500 },
]);
const serve = (report: unknown = REPORT) => script((u) => (u.includes('reports-budget-tracking') ? ok(report) : undefined));
const reportUrls = () => vi.mocked(apiFetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('reports-budget-tracking'));
const row = (sel: string) => document.querySelector(sel) as HTMLTableRowElement;
const lineRow = (name: string) => screen.getByRole('button', { name: new RegExp(name) }).closest('tr') as HTMLTableRowElement;
const cells = (tr: HTMLTableRowElement) => Array.from(tr.querySelectorAll('td')).map((td) => td.textContent ?? '');

describe('budget vs actual bands', () => {
  it('renders the income-statement bands and the engine net profit (budget 500, actual 700, +200)', async () => {
    serve();
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(row('tr[data-kind="section"]').textContent).toBe('Turnover');
    expect(screen.getByText('Total Turnover')).toBeTruthy();
    expect(screen.getByText('Total Operating Expenses')).toBeTruthy();
    const np = cells(row('tr[data-kind="grand"]'));
    expect(np[0]).toBe('Net Profit / (Loss)');
    // Actual, Budget, Δ Budget.
    expect([np[1], np[2], np[3]]).toEqual(['700.00', '500.00', '+200.00']);
  });

  it('a profit total is the engine band figure, not a sum in the page', async () => {
    const sentinel = { ...REPORT, bands: REPORT.bands.map((b) => (b.key === 'net_profit' ? { ...b, actual: 12345 } : b)) };
    serve(sentinel);
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    expect(cells(row('tr[data-kind="grand"]'))[1]).toMatch(/^12\s345\.00$/);
  });

  it('unbudgeted revenue shows — in Budget, Δ and Δ%, with no colour', async () => {
    serve();
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Other sales/ });
    const c = cells(lineRow('Other sales'));
    expect([c[2], c[3], c[5]]).toEqual(['—', '—', '—']);
    expect(lineRow('Other sales').innerHTML).not.toMatch(/var\(--ff-(un)?fav\)/);
    expect(lineRow('Other sales').textContent).not.toMatch(/100\.0%/);
  });

  it('revenue over budget is favourable; an expense over budget prints a positive movement and is unfavourable', async () => {
    serve();
    render(<BudgetVsActualPage />);
    await screen.findByRole('button', { name: /Sales/ });
    // Cells: label, Actual, Budget, Δ Budget, bar, Δ%.
    const tds = (name: string) => Array.from(lineRow(name).querySelectorAll('td'));
    const sales = tds('Sales');
    expect([sales[3]!.textContent, sales[5]!.textContent]).toEqual(['+200.00', '+20.0%']);
    expect([sales[3]!.style.color, sales[5]!.style.color]).toEqual(['var(--ff-fav)', 'var(--ff-fav)']);
    const rent = tds('Rent');
    expect(rent[3]!.textContent).toBe('+300.00');
    expect([rent[3]!.style.color, rent[5]!.style.color]).toEqual(['var(--ff-unfav)', 'var(--ff-unfav)']);
  });

  it('defaults to Year to date and sends period=ytd', async () => {
    serve();
    render(<BudgetVsActualPage />);
    await waitFor(() => expect(reportUrls()[0]).toMatch(/\?period=ytd&group_by=cc1$/));
    expect(await screen.findByDisplayValue('Year to date')).toBeTruthy();
  });
});
