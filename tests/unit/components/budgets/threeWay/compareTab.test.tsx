/**
 * The Compare tab (budgets P6 spec §8, §13.22): pick up to three versions (the one on screen first); the KPI table's
 * Δ cells take their ink from `varianceColor` alone (favourable / unfavourable), Δ = 0 stays neutral, Δ% "—" when
 * the first is 0; a refused compare shows its message, never an empty table.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';
import type { CompareView } from '@/modules/accounting/services/budgets/threeWay/threeWayViews';
import { version, V1, V2 } from './fixtures';

const h = vi.hoisted(() => ({ fetchCompare: vi.fn() }));
vi.mock('@/components/accounting/budgets/threeWay/threeWayClient', () => h);
vi.mock('@/components/accounting/charts/ChartFrame', () => ({
  useChartPalette: () => DEFAULT_PALETTE,
  ChartFrame: () => <div data-testid="chart" />,
}));

import { CompareTab } from '@/components/accounting/budgets/threeWay/CompareTab';

afterEach(() => { cleanup(); h.fetchCompare.mockReset(); });

const V3 = '33333333-3333-4333-8333-333333333333';
const V4 = '44444444-4444-4444-8444-444444444444';
const versions = [version(), version({ id: V2, name: 'Worst', isPrimary: false }), version({ id: V3, name: 'Best', isPrimary: false }), version({ id: V4, name: 'Other', isPrimary: false })];
const k = (value: number, delta: number, deltaPct: number | null, favourable: boolean | null) => ({ value, delta, deltaPct, favourable });
const kpis = (cash: ReturnType<typeof k>, ar: ReturnType<typeof k>) => ({
  closingCash: cash, minCash: cash, netProfit: k(0, 0, null, null), closingReceivables: ar, closingPayables: k(0, 0, null, null), netDebt: k(0, 0, null, null),
});
const answer: CompareView = {
  fiscalYear: 2027, months: ['2026-03'],
  versions: [
    { versionId: V1, name: 'FY2027 Plan', cashSeries: [100_00], cashDelta: [0], minCashMonth: '2026-03', warnings: [], kpis: kpis(k(100_00, 0, 0, null), k(10_00, 0, 0, null)) },
    { versionId: V2, name: 'Worst', cashSeries: [80_00], cashDelta: [-20_00], minCashMonth: '2026-03', warnings: [], kpis: kpis(k(80_00, -20_00, -20, false), k(5_00, -5_00, -50, true)) },
  ],
};
/** happy-dom keeps the hex as written; a browser would report rgb(). Either names the same ink. */
const ink = (el: HTMLElement) => el.style.color;

describe('CompareTab', () => {
  it('compares the version on screen with the picked ones, at most three', async () => {
    h.fetchCompare.mockResolvedValue({ ok: true, data: answer });
    render(<CompareTab versions={versions} currentId={V1} />);
    fireEvent.click(screen.getByLabelText('Worst'));
    await waitFor(() => expect(h.fetchCompare).toHaveBeenLastCalledWith([V1, V2]));
    fireEvent.click(screen.getByLabelText('Best'));
    expect((screen.getByLabelText('Other') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('FY2027 Plan') as HTMLInputElement).disabled).toBe(true);
  });

  it('Δ ink: unfavourable cash red, favourable (lower) receivables green, Δ = 0 neutral, Δ% "—" on a zero base', async () => {
    h.fetchCompare.mockResolvedValue({ ok: true, data: answer });
    render(<CompareTab versions={versions} currentId={V1} />);
    fireEvent.click(screen.getByLabelText('Worst'));
    const table = await screen.findByTestId('compare-kpis');
    const cashDelta = within(table).getByTestId(`delta-closingCash-${V2}`);
    expect(ink(cashDelta)).toBe(DEFAULT_PALETTE.unfav);
    expect(ink(within(table).getByTestId(`delta-closingReceivables-${V2}`))).toBe(DEFAULT_PALETTE.fav);
    expect(ink(within(table).getByTestId(`delta-netProfit-${V2}`))).toBe('');
    expect(within(table).getByTestId(`deltapct-netProfit-${V2}`).textContent).toBe('—');
    expect(within(table).queryByTestId(`delta-closingCash-${V1}`)).toBeNull();
  });

  it("each version's run warnings are listed under its name", async () => {
    const withWarnings: CompareView = { ...answer, versions: answer.versions.map((v, i) => (i === 1 ? { ...v, warnings: [{ code: 'negative_cash', months: ['2026-04'] }] } : v)) };
    h.fetchCompare.mockResolvedValue({ ok: true, data: withWarnings });
    render(<CompareTab versions={versions} currentId={V1} />);
    fireEvent.click(screen.getByLabelText('Worst'));
    const list = await screen.findByTestId('compare-warnings');
    expect(list.textContent).toMatch(/Worst: Cash below zero in 2026-04/);
    expect(list.textContent).not.toMatch(/FY2027 Plan:/);
  });

  it('a refused compare shows its message', async () => {
    h.fetchCompare.mockResolvedValue({ ok: false, kind: 'invalid', message: 'Compare versions of one financial year only', code: 'BUDGET_THREE_WAY_INPUT' });
    render(<CompareTab versions={versions} currentId={V1} />);
    fireEvent.click(screen.getByLabelText('Worst'));
    expect((await screen.findByRole('alert')).textContent).toContain('one financial year');
    expect(screen.queryByTestId('compare-kpis')).toBeNull();
  });
});

describe('CompareTab across a change of the version on screen (review M1)', () => {
  it('drops the old picks and their answer, never compares [new, ...old picks], never leaves the boxes disabled', async () => {
    let late: (v: unknown) => void = () => undefined;
    h.fetchCompare.mockImplementationOnce(() => new Promise((r) => { late = r; }));
    const { rerender } = render(<CompareTab versions={versions} currentId={V1} />);
    fireEvent.click(screen.getByLabelText('Worst'));
    await waitFor(() => expect(h.fetchCompare).toHaveBeenCalledTimes(1));
    rerender(<CompareTab versions={versions} currentId={V3} />);
    await waitFor(() => expect((screen.getByLabelText('Worst') as HTMLInputElement).disabled).toBe(false));
    expect((screen.getByLabelText('Worst') as HTMLInputElement).checked).toBe(false);
    expect(h.fetchCompare.mock.calls.map((c) => (c[0] as string[])[0])).toEqual([V1]);
    late({ ok: true, data: answer });
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('compare-kpis')).toBeNull();
  });
});
