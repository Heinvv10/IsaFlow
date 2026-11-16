/**
 * The Cash Flow Forecast page (cash13 PR 3): one page, "13 weeks" by default, "AI outlook" on ?tab=ai (with no
 * AI key, a plain sentence and nothing that calls the AI route); the 13-week tab rendered from a real-engine
 * forecast: header, grid with groups, estimate and basis labels, overdue panel, warnings in plain English;
 * viewers and a missing data layer read only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';

vi.mock('@/components/accounting/cashForecast13/cash13Client', async () => (await import('./setup')).client);
vi.mock('@/contexts/CompanyContext', async () => (await import('./setup')).companyModule());
vi.mock('next/router', async () => (await import('./setup')).routerModule());
vi.mock('@/components/layout/AppLayout', async () => (await import('./setup')).layoutModule());
vi.mock('@/components/accounting/charts/ChartFrame', async () => (await import('./setup')).chartModule());
vi.mock('@/components/accounting/CashFlowForecastChart', () => ({
  CashFlowForecastChart: () => null, KpiCard: () => null, ConfidencePip: () => null, buildChartData: () => [], fmtCurrency: String, fmtShortDate: String,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), assertOk: vi.fn(), apiErrorMessage: vi.fn() }));

import CashFlowForecastPage from '../../../../pages/accounting/reports/cash-flow-forecast';
import { apiFetch } from '@/lib/apiFetch';
import { answerDefaults, client, notFound, ok, role, router } from './setup';
import { forecastFixture, WARNINGS } from './fixture';

beforeEach(() => { answerDefaults(); vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });

const grid = () => screen.findByRole('table', { name: '13-week cash forecast' });

describe('tabs', () => {
  it('opens on "13 weeks" and loads the forecast', async () => {
    render(<CashFlowForecastPage aiConfigured />);
    expect(screen.getByRole('tab', { name: '13 weeks' }).getAttribute('aria-selected')).toBe('true');
    await grid();
    expect(client.fetchForecast).toHaveBeenCalledTimes(1);
  });

  it('AI outlook with no key: a plain sentence, no Generate button, no call', async () => {
    router.query = { tab: 'ai' };
    render(<CashFlowForecastPage aiConfigured={false} />);
    expect(screen.getByText('AI forecast unavailable: no AI key is configured.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /generate forecast/i })).toBeNull();
    expect(apiFetch).not.toHaveBeenCalled();
    expect(client.fetchForecast).not.toHaveBeenCalled();
  });

  it('AI outlook with a key: the AI forecast as it was', () => {
    router.query = { tab: 'ai' };
    render(<CashFlowForecastPage aiConfigured />);
    expect(screen.getByRole('button', { name: /generate forecast/i })).toBeTruthy();
  });
});

describe('13 weeks from the engine', () => {
  it('header: opening cash today and the lowest week with its date', async () => {
    const f = forecastFixture({ overrides: [] });
    render(<CashFlowForecastPage />);
    await grid();
    expect(screen.getByTestId('kpi-opening').textContent).toContain('R 10 000');
    const low = f.weeks.reduce((a, b) => (b.closingCents < a.closingCents ? b : a));
    expect(low.closingCents).toBeLessThan(0);
    const kpi = screen.getByTestId('kpi-lowest').textContent ?? '';
    expect(kpi).toContain(`Week ${low.index + 1} ·`);
    expect(kpi).toMatch(/\(R [\d\s ]+\)/);
  });

  it('grid: weeks across, groups with subtotals, opening and closing rows', async () => {
    render(<CashFlowForecastPage />);
    const table = await grid();
    expect(within(table).getByRole('columnheader', { name: 'Week 1 · 16 Nov' })).toBeTruthy();
    for (const g of ['Receipts from customers', 'Supplier payments', 'Payroll', 'SARS', 'Loans', 'Recurring invoices', 'Budget estimate', 'Expected items you added']) {
      expect(within(table).getByRole('rowheader', { name: g }).getAttribute('scope')).toBe('rowgroup');
      expect(within(table).getByRole('rowheader', { name: `Total ${g.toLowerCase()}` })).toBeTruthy();
    }
    expect(within(table).getByRole('rowheader', { name: 'Opening cash' })).toBeTruthy();
    const closing = screen.getByTestId('closing-row');
    expect(closing.querySelector('.text-red-600')).not.toBeNull();
  });

  it('budget lines are dimmed and labelled estimate', async () => {
    render(<CashFlowForecastPage />);
    await grid();
    const row = document.querySelector('[data-line="budget:customer_receipts"]') as HTMLElement;
    expect(row.className).toContain('opacity-60');
    expect(within(row).getByText('estimate')).toBeTruthy();
  });

  it('an AR line (one per customer) shows its basis breakdown as a tooltip, and the no-history flag', async () => {
    render(<CashFlowForecastPage />);
    await grid();
    const sp = (t: string | null) => (t ?? '').replace(/\u00a0/g, ' ');
    const acme = document.querySelector('[data-line="ar:c1"]') as HTMLElement;
    const basis = within(acme).getByTestId('ar-basis');
    expect(basis.textContent).toContain('due · history');
    expect(sp(basis.getAttribute('title'))).toBe('Expected: due R 5 000 · history R 1 200 · no history R 0');
    expect(within(acme).queryByTestId('ar-no-history')).toBeNull();
    const gamma = document.querySelector('[data-line="ar:c3"]') as HTMLElement;
    expect(sp(within(gamma).getByTestId('ar-basis').getAttribute('title'))).toBe('Expected: due R 0 · history R 0 · no history R 1 000');
    const flag = within(gamma).getByTestId('ar-no-history');
    expect(flag.textContent).toContain('no payment history');
    expect(flag.getAttribute('title')).toMatch(/too few paid invoices/);
  });

  it('overdue panel: total, by basis, beyond the horizon', async () => {
    render(<CashFlowForecastPage />);
    await grid();
    expect(screen.getByTestId('overdue-total').textContent).toBe('R 4 000');
    const panel = screen.getByRole('region', { name: 'Overdue customer invoices' });
    expect(panel.textContent).toContain('R 3 000');
    expect(panel.textContent).toContain('R 1 000');
    expect(panel.textContent).toContain('R 500');
  });

  it('warnings in plain English, never a code', async () => {
    render(<CashFlowForecastPage />);
    await grid();
    const list = screen.getByTestId('cash13-warnings');
    expect(list.querySelectorAll('li').length).toBe(WARNINGS.length);
    expect(list.textContent).toContain('Could not read the loans');
    expect(list.textContent).toContain('assumed paid');
    for (const w of WARNINGS) expect(document.body.textContent).not.toContain(w.code);
  });

  it('a refused forecast shows the server\'s message', async () => {
    client.fetchForecast.mockResolvedValue({ ok: false, kind: 'busy', message: 'Opening cash could not be read', retryAfter: null });
    render(<CashFlowForecastPage />);
    expect(await screen.findByText('Opening cash could not be read')).toBeTruthy();
  });
});

describe('who may edit', () => {
  it('a writer gets clickable cells and "Add expected item"', async () => {
    render(<CashFlowForecastPage />);
    await grid();
    expect(screen.getAllByRole('button', { name: /^Change Steel Supplies, Week 2/ }).length).toBe(1);
    expect(screen.getByRole('button', { name: 'Add expected item' })).toBeTruthy();
  });

  it('a viewer reads only: no cell buttons, no add, no pay-day form', async () => {
    role.current = 'viewer';
    render(<CashFlowForecastPage />);
    await grid();
    expect(screen.queryAllByRole('button', { name: /^Change / })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Add expected item' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save pay day' })).toBeNull();
    expect(screen.getByTestId('read-only-note')).toBeTruthy();
  });

  it('data layer not deployed (404): a writer reads only, with a note', async () => {
    client.fetchOverrides.mockResolvedValue(notFound);
    render(<CashFlowForecastPage />);
    await grid();
    expect(screen.queryAllByRole('button', { name: /^Change / })).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Add expected item' })).toBeNull();
    expect(screen.getByTestId('store-missing')).toBeTruthy();
  });

  it('a cell changed by hand carries a marker', async () => {
    const f = forecastFixture({ overrides: [] });
    client.fetchOverrides.mockResolvedValue(ok([{ id: 'o1', lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'set', amount: -6000, note: 'agreed' }]));
    render(<CashFlowForecastPage />);
    await grid();
    expect(screen.getByRole('button', { name: /^Change Steel Supplies, Week 2 .*changed by hand: agreed$/ })).toBeTruthy();
  });
});
