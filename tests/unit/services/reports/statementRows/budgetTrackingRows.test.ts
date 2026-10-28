/**
 * Budgets P3 §2.1/§3: the tracking report → StatementRow[] adapter COPIES.
 * Band and profit figures come from the engine's bands, never from summing
 * the lines here: the fixture's bands are SENTINELS that do not equal the sum
 * of their lines, so an adapter that derives goes red. "Unbudgeted" arrives
 * as `absent`, never as a zero budget.
 */
import { describe, expect, it } from 'vitest';
import { toBudgetTrackingRows } from '@/modules/accounting/services/reports/statementRows/budgetTrackingRows';
import { NON_FIGURE_KINDS } from '@/modules/accounting/services/reports/statementRows/statementModel';
import type { TrackingBand, TrackingLine } from '@/modules/accounting/services/budgets/tracking/trackingTypes';

const fig = (o: Partial<TrackingLine>): Omit<TrackingLine, 'accountId' | 'accountCode' | 'accountName' | 'accountType' | 'band'> => ({
  actual: 0, budget: null, variance: null, variancePct: null, favourable: null,
  projected: 0, fyBudget: null, projVariance: null, projFavourable: null, unallocatedBudget: 0,
  budgetAboveFilter: false, monthly: [], ...o,
});
const line = (accountCode: string, band: TrackingLine['band'], o: Partial<TrackingLine>): TrackingLine => ({
  accountId: `id-${accountCode}`, accountCode, accountName: `Name ${accountCode}`,
  accountType: band === 'turnover' || band === 'other_income' ? 'revenue' : 'expense', band, ...fig(o),
});
const band = (key: TrackingBand['key'], kind: TrackingBand['kind'], o: Partial<TrackingBand>): TrackingBand => ({
  key, label: `L ${key}`, kind, polarity: 'income',
  actual: 0, budget: null, variance: null, variancePct: null, favourable: null,
  projected: 0, fyBudget: null, projVariance: null, projFavourable: null, unallocatedBudget: 0, ...o,
});

const LINES: TrackingLine[] = [
  line('4000', 'turnover', { actual: 100, budget: 90, variance: 10, variancePct: 11.11, favourable: true, projected: 1000, fyBudget: 1080, projVariance: -80, projFavourable: false }),
  line('4100', 'turnover', { actual: 5, unallocatedBudget: 7, budgetAboveFilter: true, projected: 5 }),
  line('6000', 'operating_expense', { actual: 40, budget: 0, variance: 40, variancePct: null, favourable: false, projected: 40, fyBudget: 0, projVariance: 40, projFavourable: false }),
];
// Sentinels: none of these equals the sum of the lines above.
const BANDS: TrackingBand[] = [
  band('turnover', 'band', { actual: 777.77, budget: 666.66, variance: 111.11, variancePct: 16.67, favourable: true, projected: 9999, fyBudget: 8888, projVariance: 1111, projFavourable: true, unallocatedBudget: 3 }),
  band('cost_of_sales', 'band', {}),
  band('gross_profit', 'total', { actual: 1.23, budget: 4.56, variance: -3.33, variancePct: -73.03, favourable: false, projected: 7, fyBudget: 8, projVariance: -1, projFavourable: false }),
  band('other_income', 'band', {}),
  band('operating_expense', 'band', { actual: 55.55, budget: 44.44, variance: 11.11, favourable: false, polarity: 'expense' }),
  band('operating_profit', 'total', { actual: 2.22 }),
  band('other_expense', 'band', {}),
  band('net_profit', 'grand', { actual: 3.33, budget: 2.22, variance: 1.11, variancePct: 50, favourable: true, projected: 30, fyBudget: 20, projVariance: 10, projFavourable: true }),
];

const ROWS = toBudgetTrackingRows({ lines: LINES, bands: BANDS });
const row = (id: string) => ROWS.find((r) => r.id === id)!;

describe('toBudgetTrackingRows', () => {
  it('lays out the income statement bands; an empty COS / other band is left out, as on the statement', () => {
    expect(ROWS.map((r) => r.id)).toEqual([
      'sec:turnover', 'acc:4000', 'acc:4100', 'sub:turnover', 'total:gross_profit',
      'sec:operating_expense', 'acc:6000', 'sub:operating_expense', 'total:operating_profit', 'grand:net_profit',
    ]);
    expect(row('sec:turnover').kind).toBe('section');
    expect(NON_FIGURE_KINDS.has(row('sec:turnover').kind)).toBe(true);
  });

  it("copies a line's figures, the movement-signed variance and its %", () => {
    expect(row('acc:4000')).toMatchObject({
      kind: 'line', depth: 1, accountCode: '4000', label: 'Name 4000', actual: 100,
      budget: { value: 90, variance: 10, variancePct: 11.11, favourable: true },
      projection: { projected: 1000, fyBudget: 1080, variance: -80, favourable: false },
    });
  });

  it('an unbudgeted line is absent (no value printed, no colour); a zero budget is a 0', () => {
    expect(row('acc:4100').budget).toEqual({ value: 0, absent: true });
    expect(row('acc:4100').projection).toEqual({ projected: 5, absent: true });
    expect(row('acc:4100').unallocatedBudget).toBe(7);
    expect(row('acc:6000').budget).toEqual({ value: 0, variance: 40, favourable: false });
  });

  it("subtotal and profit rows carry the ENGINE's band figures, never a sum of the lines", () => {
    expect(row('sub:turnover')).toMatchObject({
      kind: 'subtotal', label: 'Total L turnover', actual: 777.77,
      budget: { value: 666.66, variance: 111.11, variancePct: 16.67, favourable: true },
      projection: { projected: 9999, fyBudget: 8888, variance: 1111, favourable: true }, unallocatedBudget: 3,
    });
    expect(row('sec:turnover').actual).toBe(777.77);
    expect(row('total:gross_profit')).toMatchObject({ kind: 'total', actual: 1.23, budget: { value: 4.56, variance: -3.33 } });
    expect(row('total:operating_profit').budget).toEqual({ value: 0, absent: true });
    expect(row('grand:net_profit')).toMatchObject({ kind: 'grand', actual: 3.33, budget: { value: 2.22, variance: 1.11, variancePct: 50, favourable: true } });
  });
});
