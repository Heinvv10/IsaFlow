/**
 * Review round 1 of the 13-week page: the editor works on the figure IN FORCE (source + earlier changes), a cell
 * with a stored change opens on it (a re-save replaces it), a failed items read is said (to viewers too), the
 * pay-day form keeps a half-edit across reloads, notes are a tooltip for everyone, the footer wraps on a phone,
 * and the AI tab keeps its generated forecast across tab switches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('@/components/accounting/cashForecast13/cash13Client', async () => (await import('./setup')).client);
vi.mock('@/contexts/CompanyContext', async () => (await import('./setup')).companyModule());
vi.mock('next/router', async () => (await import('./setup')).routerModule());
vi.mock('@/components/layout/AppLayout', async () => (await import('./setup')).layoutModule());
vi.mock('@/components/accounting/charts/ChartFrame', async () => (await import('./setup')).chartModule());
vi.mock('@/components/accounting/CashFlowForecastChart', () => ({
  CashFlowForecastChart: () => null, KpiCard: () => null, ConfidencePip: () => null, buildChartData: () => [], fmtCurrency: String, fmtShortDate: String,
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(), assertOk: vi.fn(async () => undefined), apiErrorMessage: vi.fn(() => 'x') }));

import CashFlowForecastPage from '../../../../pages/accounting/reports/cash-flow-forecast';
import { Cash13Tab } from '@/components/accounting/cashForecast13/Cash13Tab';
import { PayDayControl } from '@/components/accounting/cashForecast13/Cash13Inputs';
import { apiFetch } from '@/lib/apiFetch';
import { answerDefaults, client, ok, role, router } from './setup';
import { forecastFixture } from './fixture';

const f = forecastFixture({ overrides: [] });
beforeEach(() => { answerDefaults(); vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });
const sp = (t: string | null | undefined) => (t ?? '').replace(/ /g, ' ');

describe('the figure in force', () => {
  beforeEach(() => {
    client.fetchForecast.mockResolvedValue(ok(forecastFixture({ overrides: [{ lineKey: 'ap:s1', weekIndex: 1, mode: 'move_to', amountCents: null, targetWeek: 4 }] })));
  });

  it('a moved-in amount shows in "This week" and can be moved on', async () => {
    render(<Cash13Tab />);
    fireEvent.click(await screen.findByRole('button', { name: /^Change Steel Supplies, Week 5/ }));
    expect(sp(screen.getByTestId('cell-in-force').textContent)).toBe('This week: −R 8 000.00');
    expect((screen.getByLabelText('Move to another week') as HTMLInputElement).disabled).toBe(false);
  });

  it('a cell moved out reads 0 and has nothing to move', async () => {
    render(<Cash13Tab />);
    fireEvent.click(await screen.findByRole('button', { name: /^Change Steel Supplies, Week 2/ }));
    expect(sp(screen.getByTestId('cell-in-force').textContent)).toBe('This week: R 0.00');
    expect((screen.getByLabelText('Move to another week') as HTMLInputElement).disabled).toBe(true);
  });
});

describe('a stored change opens the editor on it', () => {
  it('mode, direction, amount and note are the stored ones; it says the save replaces it', async () => {
    client.fetchOverrides.mockResolvedValue(ok([{ id: 'o1', lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'add', amount: 250.5, note: 'refund due' }]));
    render(<Cash13Tab />);
    fireEvent.click(await screen.findByRole('button', { name: /^Change Steel Supplies, Week 2/ }));
    expect((screen.getByLabelText('Add') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Money in') as HTMLInputElement).checked).toBe(true);
    expect(sp((screen.getByLabelText('Amount to add') as HTMLInputElement).value)).toBe('250.50');
    expect((screen.getByLabelText('Note (optional)') as HTMLInputElement).value).toBe('refund due');
    expect(screen.getByTestId('replaces-note').textContent).toMatch(/replaces your earlier change/);
  });

  it('a stored move opens on its target week', async () => {
    client.fetchOverrides.mockResolvedValue(ok([{ id: 'o2', lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'move_to', amount: null, targetWeekStart: f.weeks[6]!.start, note: null }]));
    render(<Cash13Tab />);
    fireEvent.click(await screen.findByRole('button', { name: /^Change Steel Supplies, Week 2/ }));
    expect((screen.getByLabelText('Move to another week') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Move to') as HTMLSelectElement).value).toBe('6');
  });
});

describe('failures are said, to viewers too', () => {
  it('a failed items read is "could not be loaded" with the server\'s message, never an empty list', async () => {
    role.current = 'viewer';
    client.fetchItems.mockResolvedValue({ ok: false, kind: 'failed', message: 'The items table is locked', status: 500 });
    render(<Cash13Tab />);
    const panel = await screen.findByTestId('items-failed');
    expect(panel.textContent).toContain('Expected items could not be loaded');
    expect(panel.textContent).toContain('The items table is locked');
  });

  it('a failed store read is shown to a viewer', async () => {
    role.current = 'viewer';
    client.fetchOverrides.mockResolvedValue({ ok: false, kind: 'failed', message: 'Your changes could not be read', status: 500 });
    render(<Cash13Tab />);
    expect(await screen.findByText('Your changes could not be read')).toBeTruthy();
  });

  it('a viewer sees a change\'s note as a tooltip', async () => {
    role.current = 'viewer';
    client.fetchOverrides.mockResolvedValue(ok([{ id: 'o1', lineKey: 'ap:s1', weekStart: f.weeks[1]!.start, mode: 'set', amount: -6000, note: 'agreed' }]));
    render(<Cash13Tab />);
    await screen.findByRole('table');
    expect(document.querySelector(`[data-cell="ap:s1|${f.weeks[1]!.start}"]`)!.getAttribute('title')).toBe('agreed');
  });
});

describe('pay-day form', () => {
  const setting = (day: number) => ({ payDay: { kind: 'day_of_month' as const, day }, day, isDefault: false });
  it('a reload with the same value keeps a half-edit; a new value resets it', () => {
    const save = vi.fn();
    const { rerender } = render(<PayDayControl setting={setting(25)} canEdit onSave={save} />);
    fireEvent.change(screen.getByLabelText('Day (1 to 31)'), { target: { value: '15' } });
    rerender(<PayDayControl setting={setting(25)} canEdit onSave={save} />);
    expect((screen.getByLabelText('Day (1 to 31)') as HTMLInputElement).value).toBe('15');
    rerender(<PayDayControl setting={setting(28)} canEdit onSave={save} />);
    expect((screen.getByLabelText('Day (1 to 31)') as HTMLInputElement).value).toBe('28');
  });
});

describe('phone', () => {
  it('the editor footer wraps', async () => {
    render(<Cash13Tab />);
    fireEvent.click(await screen.findByRole('button', { name: /^Change Steel Supplies, Week 2/ }));
    const footer = within(screen.getByRole('dialog')).getByRole('button', { name: 'Save change' }).parentElement!;
    expect(footer.className).toContain('flex-wrap');
  });
});

describe('the AI tab keeps its forecast across tab switches', () => {
  it('generate, go to 13 weeks and back: still there, generated once', async () => {
    const data = { currentCashBalance: 1, projectedEndBalance: 2, forecastPeriods: [], historicalPeriods: [], risks: [], opportunities: [], summary: 'AI says cash is tight', generatedAt: '2026-11-16T10:00:00Z' };
    vi.mocked(apiFetch).mockResolvedValue({ ok: true, json: async () => ({ data }) } as unknown as Response);
    router.query = { tab: 'ai' };
    const { rerender } = render(<CashFlowForecastPage aiConfigured />);
    fireEvent.click(screen.getByRole('button', { name: /generate forecast/i }));
    expect(await screen.findByText('AI says cash is tight')).toBeTruthy();
    router.query = {};
    rerender(<CashFlowForecastPage aiConfigured />);
    await screen.findByRole('table', { name: '13-week cash forecast' });
    router.query = { tab: 'ai' };
    rerender(<CashFlowForecastPage aiConfigured />);
    await waitFor(() => expect(screen.getByText('AI says cash is tight')).toBeTruthy());
    expect(apiFetch).toHaveBeenCalledTimes(1);
  });
});
