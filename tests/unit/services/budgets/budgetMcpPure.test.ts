/**
 * The pure pieces behind the MCP budget tools: the cell write plan (merge / add / replace), the seed
 * adjustments (section / account uplift, fixed annual, flat seasonality), the annual spread, and the money
 * text parser (decimal strings only, at most 2 decimals, exact cents).
 */
import { describe, expect, it } from 'vitest';
import { countPlan, planCellWrites, type CurrentCell, type PlanInput } from '@/modules/accounting/services/budgets/cellWritePlan';
import { adjustSeedSeries, roundingFlips } from '@/modules/accounting/services/budgets/seedAdjust';
import { budgetPlanHash } from '@/modules/accounting/services/budgets/budgetPlanHash';
import { spreadAnnual } from '@/modules/accounting/services/budgets/annualSpread';
import { centsText, parseMoney } from '@/lib/mcp/tools/budgetToolArgs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C1 = '33333333-3333-4333-8333-333333333333';
const key = (acct: string, month: string, cc1: string | null = null) => `${acct}|${cc1 ?? ''}|||${month}`;
const input = (index: number, acct: string, month: string, cents: number | null, cc1: string | null = null): PlanInput =>
  ({ index, glAccountId: acct, cc1Id: cc1, cc2Id: null, buId: null, month, cents });
const cur = (entries: Array<[string, number, string?]>) => new Map<string, CurrentCell>(entries.map(([k, c, s]) => [k, { cents: c, source: s ?? 'typed' }]));

describe('planCellWrites', () => {
  it('merge sets the listed cells only, null clears, an equal value is unchanged and not sent', () => {
    const current = cur([[key(A, '2026-03'), 1000], [key(A, '2026-04'), 2000], [key(A, '2026-05'), 3000]]);
    const plan = planCellWrites('merge', [input(0, A, '2026-03', 1500), input(1, A, '2026-04', null), input(2, A, '2026-05', 3000), input(3, B, '2026-03', 700)], current);
    expect(countPlan(plan.entries)).toEqual({ added: 1, changed: 1, removed: 1, unchanged: 1, refused: 0 });
    expect(plan.save).toEqual([
      { glAccountId: A, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 15 },
      { glAccountId: A, cc1Id: null, cc2Id: null, buId: null, month: '2026-04', amount: null, clear: true },
      { glAccountId: B, cc1Id: null, cc2Id: null, buId: null, month: '2026-03', amount: 7 },
    ]);
  });

  it('add adds to the current amount (absent = 0) and refuses a null', () => {
    const plan = planCellWrites('add', [input(0, A, '2026-03', 250), input(1, A, '2026-04', -100), input(2, B, '2026-03', null)], cur([[key(A, '2026-03'), 1000]]));
    expect(plan.entries.map((e) => [e.status, e.after])).toEqual([['changed', 1250], ['added', -100], ['refused', null]]);
    expect(plan.entries[2]!.reason).toMatch(/add needs an amount/);
  });

  it('replace clears every other cell of a listed account (other months and other levels) but never a closed month', () => {
    const current = cur([
      [key(A, '2026-03'), 1000], [key(A, '2026-04', C1), 500], [key(A, '2026-05'), 400, 'actual'], [key(B, '2026-03'), 9],
    ]);
    const plan = planCellWrites('replace', [input(0, A, '2026-06', 100)], current);
    const byKey = Object.fromEntries(plan.entries.map((e) => [e.key, e.status]));
    expect(byKey).toEqual({ [key(A, '2026-06')]: 'added', [key(A, '2026-03')]: 'removed', [key(A, '2026-04', C1)]: 'removed' });
    expect(plan.save).toHaveLength(3);
  });

  it('the same cell twice is refused on the second listing', () => {
    const plan = planCellWrites('merge', [input(0, A, '2026-03', 1), input(1, A, '2026-03', 2)], new Map());
    expect(plan.entries.map((e) => e.status)).toEqual(['added', 'refused']);
  });
});

describe('adjustSeedSeries', () => {
  const series = (acct: string, cents: number[], cc1: string | null = null) =>
    ({ glAccountId: acct, cc1Id: cc1, cc2Id: null, buId: null, positions: cents.map((_, i) => i), cents });
  const accounts = new Map([[A, { label: '6000 Rent', band: 'operating_expense' as const }], [B, { label: '4000 Sales', band: 'turnover' as const }]]);

  it('account uplift beats section uplift beats the seed uplift', () => {
    const out = adjustSeedSeries([series(A, [10000, 10000]), series(B, [10000, 10000])], 0, 1,
      { accountUplift: new Map([[A, 50]]), sectionUplift: new Map([['operating_expense', 10], ['turnover', 20]]) }, accounts, 2);
    expect(out.filter((c) => c.series.glAccountId === A).map((c) => c.cents)).toEqual([15000, 15000]);
    expect(out.filter((c) => c.series.glAccountId === B).map((c) => c.cents)).toEqual([12000, 12000]);
  });

  it('a fixed annual amount is spread by the source shape, residue on the last month, and shared across dimension rows', () => {
    const out = adjustSeedSeries([series(A, [100, 300], C1), series(A, [100, 0])], 0, 1, { fixedAnnual: new Map([[A, 100000]]) }, accounts, 2);
    const total = out.reduce((s, c) => s + c.cents, 0);
    expect(total).toBe(100000);
    expect(out.map((c) => c.cents)).toEqual([20000, 60000, 20000, 0]);
  });

  it('flat seasonality spreads evenly with the residue on the last month; a fixed amount with no source shape is refused', () => {
    const flat = adjustSeedSeries([series(A, [100, 900, 0])], 0, 1, { fixedAnnual: new Map([[A, 100000]]), seasonality: 'flat' }, accounts, 3);
    expect(flat.map((c) => c.cents)).toEqual([33300, 33300, 33400]);
    expect(() => adjustSeedSeries([series(A, [0, 0])], 0, 1, { fixedAnnual: new Map([[A, 100]]) }, accounts, 2)).toThrow(/6000 Rent.*no monthly shape/);
    expect(() => adjustSeedSeries([series(B, [1, 1])], 0, 1, { fixedAnnual: new Map([[A, 100]]) }, accounts, 2)).toThrow(/no row in the seed's source/);
  });

  it('flat spreads over EVERY month of the target year, from a sparse version source (2 of 14 months)', () => {
    const sparse = { glAccountId: A, cc1Id: null, cc2Id: null, buId: null, positions: [2, 9], cents: [70000, 70000] };
    const fixed = adjustSeedSeries([sparse], 0, 1, { fixedAnnual: new Map([[A, 140000]]), seasonality: 'flat' }, accounts, 14);
    expect(fixed.map((c) => c.position)).toEqual([...Array(14).keys()]);
    expect(fixed.map((c) => c.cents)).toEqual(Array(14).fill(10000));
    const lifted = adjustSeedSeries([sparse], 10, 1, { seasonality: 'flat' }, accounts, 14);
    expect(lifted.map((c) => c.position)).toEqual([...Array(14).keys()]);
    expect(lifted.reduce((t, c) => t + c.cents, 0)).toBe(154000);
  });

  it('an account uplift for an account with no source row is refused, as a fixed amount is', () => {
    expect(() => adjustSeedSeries([series(B, [1, 1])], 0, 1, { accountUplift: new Map([[A, 5]]) }, accounts, 2)).toThrow(/6000 Rent has no row in the seed's source to place an uplift/);
  });

  it('roundingFlips names an account whose last month the rounding pushed past zero, not one whose source already was', () => {
    const s1 = series(A, [100, 100, 100]);
    const s2 = { ...series(B, [100, 100, -50]) };
    const cells = [
      ...[100000, 100000, -50000].map((cents, position) => ({ series: s1, position, cents })),
      ...[100000, 100000, -50000].map((cents, position) => ({ series: s2, position, cents })),
    ];
    expect(roundingFlips(cells, new Map([[A, '6000 Rent'], [B, '4000 Sales']]))).toEqual(['6000 Rent']);
  });
});

describe('spreadAnnual', () => {
  it('flat: rounded to the unit, the last month takes the residue', () => {
    expect(spreadAnnual(100000, 3, { kind: 'flat' }, 1)).toEqual({ ok: true, months: [33300, 33300, 33400] });
  });
  it('prior_year: proportional; no activity is refused, never guessed', () => {
    expect(spreadAnnual(1000000, 2, { kind: 'prior_year', priorCents: [100, 300] }, 1)).toEqual({ ok: true, months: [250000, 750000] });
    expect(spreadAnnual(1000, 2, { kind: 'prior_year', priorCents: [0, 0] }, 1)).toMatchObject({ ok: false, reason: expect.stringMatching(/no prior-year activity/) });
  });
  it('weights: one per month, whole numbers', () => {
    expect(spreadAnnual(100000, 2, { kind: 'weights', weights: [1, 3] }, 1)).toEqual({ ok: true, months: [25000, 75000] });
    expect(spreadAnnual(100000, 3, { kind: 'weights', weights: [1, 3] }, 1)).toMatchObject({ ok: false });
  });
});

describe('parseMoney / centsText', () => {
  it.each([
    ['1250', 125000, '1250.00'], ['-30.5', -3050, '-30.50'], ['0.75', 75, '0.75'], ['-0.05', -5, '-0.05'],
    ['9999999999999.99', 999999999999999, '9999999999999.99'], ['282543.34', 28254334, '282543.34'],
  ])('%s → %i cents → %s', (text, cents, back) => {
    expect(parseMoney(text)).toEqual({ cents });
    expect(centsText(cents)).toBe(back);
  });
  it.each([[12.5, /decimal strings/], ['1.005', /at most 2 decimals/], ['1e5', /not a decimal/], ['', /not a decimal/], ['99999999999999', /not a decimal/]])('%s is refused', (v, why) => {
    expect((parseMoney(v) as { error: string }).error).toMatch(why);
  });
});

describe('budgetPlanHash', () => {
  const cell = { key: 'a|||2026-03', before: 100, beforeSource: 'typed', after: 200 };
  it('is the same for the same plan and differs for any change of version, kind, token, before, source or after', () => {
    const h = budgetPlanHash('V', 'set:merge', 'T', [cell]);
    expect(budgetPlanHash('v', 'set:merge', 'T', [cell])).toBe(h);
    for (const other of [
      budgetPlanHash('W', 'set:merge', 'T', [cell]), budgetPlanHash('V', 'set:add', 'T', [cell]), budgetPlanHash('V', 'set:merge', 'U', [cell]),
      budgetPlanHash('V', 'set:merge', 'T', [{ ...cell, before: 101 }]), budgetPlanHash('V', 'set:merge', 'T', [{ ...cell, beforeSource: 'override' }]),
      budgetPlanHash('V', 'set:merge', 'T', [{ ...cell, after: 201 }]),
    ]) expect(other).not.toBe(h);
  });
});
