/**
 * Review rounds 1-2 of the 13-week page: a re-save previews the engine's own result (the base leaves out the
 * cell's own stored change, which the save replaces), a cell
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
import { toEngineOverrides } from '@/components/accounting/cashForecast13/editorBase';

const f = forecastFixture({ overrides: [] });
beforeEach(() => { answerDefaults(); vi.mocked(apiFetch).mockReset(); });
afterEach(() => { cleanup(); });
const sp = (t: string | null | undefined) => (t ?? '').replace(/ /g, ' ');

describe('re-saving a changed week (forecast and store agree, as the route sends them)', () => {
  const W = (i: number) => f.weeks[i]!.start;
  type St = { id: string; lineKey: string; weekStart: string; mode: 'set' | 'add' | 'move_to'; amount: number | null; targetWeekStart?: string; note: string | null };
  function agree(stored: St[]) {
    client.fetchForecast.mockResolvedValue(ok(forecastFixture({ overrides: toEngineOverrides(stored, f.weeks) })));
    client.fetchOverrides.mockResolvedValue(ok(stored));
  }
  async function open(week: number) {
    render(<Cash13Tab />);
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^Change Steel Supplies, Week ${week} `) }));
    return screen.findByRole('dialog');
  }
  const preview = () => sp(screen.getByTestId('override-preview').textContent);

  it('a stored add +250.50 previews the engine\'s -7 749.50 and re-saves the same body', async () => {
    agree([{ id: 'o1', lineKey: 'ap:s1', weekStart: W(1), mode: 'add', amount: 250.5, note: null }]);
    await open(2);
    expect(sp(screen.getByTestId('cell-in-force').textContent)).toBe('This week: −R 7 749.50');
    expect(preview()).toBe('Week 2 will be −R 7 749.50.');
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(client.saveOverride).toHaveBeenCalledWith({ lineKey: 'ap:s1', weekStart: W(1), mode: 'add', amount: 250.5, note: null }));
  });

  it('a stored partial move of 2 000 previews -6 000 / -2 000', async () => {
    agree([{ id: 'o1', lineKey: 'ap:s1', weekStart: W(1), mode: 'move_to', amount: 2000, targetWeekStart: W(4), note: null }]);
    await open(2);
    expect(preview()).toBe('Week 2 will be −R 6 000.00 and week 5 will be −R 2 000.00.');
  });

  it('a stored whole-week move can be edited: Move is enabled and the save goes through', async () => {
    agree([{ id: 'o1', lineKey: 'ap:s1', weekStart: W(1), mode: 'move_to', amount: null, targetWeekStart: W(4), note: null }]);
    await open(2);
    expect(sp(screen.getByTestId('cell-in-force').textContent)).toBe('This week: R 0.00');
    expect(sp(screen.getByTestId('replaces-note').textContent)).toContain('Without it the week is −R 8 000.00');
    expect((screen.getByLabelText('Move to another week') as HTMLInputElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText('Move to'), { target: { value: '6' } });
    expect(preview()).toBe('Week 2 will be R 0.00 and week 7 will be −R 8 000.00.');
    fireEvent.click(screen.getByRole('button', { name: 'Save change' }));
    await waitFor(() => expect(client.saveOverride).toHaveBeenCalledWith(expect.objectContaining({ mode: 'move_to', amount: null, targetWeekStart: W(6) })));
  });

  it('a stored set -6 000 previews -6 000', async () => {
    agree([{ id: 'o1', lineKey: 'ap:s1', weekStart: W(1), mode: 'set', amount: -6000, note: null }]);
    await open(2);
    expect(preview()).toBe('Week 2 will be −R 6 000.00.');
  });

  it('money moved in by another cell\'s change is in this week and can be moved on', async () => {
    agree([{ id: 'o1', lineKey: 'ap:s1', weekStart: W(1), mode: 'move_to', amount: null, targetWeekStart: W(4), note: null }]);
    await open(5);
    expect(sp(screen.getByTestId('cell-in-force').textContent)).toBe('This week: −R 8 000.00');
    expect((screen.getByLabelText('Move to another week') as HTMLInputElement).disabled).toBe(false);
    expect(screen.queryByTestId('replaces-note')).toBeNull();
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
