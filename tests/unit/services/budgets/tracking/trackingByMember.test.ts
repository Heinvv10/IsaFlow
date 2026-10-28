/**
 * Budgets P3 §2.7 bullets (review Q9): per-member net profit, the untagged /
 * company-level member last, and the mapping onto P0's BudgetVsActualLine that
 * the unchanged BudgetBulletRow / bulletOption reads: `variance` favourably
 * signed (for a profit figure it equals the movement), `budgeted` from the
 * presence of a budget, never from its amount.
 */
import { describe, expect, it } from 'vitest';
import { buildTrackingMembers, toBulletLines, UNTAGGED_LABEL } from '@/modules/accounting/services/budgets/tracking/trackingByMember';
import { buildBudgetBulletOption } from '@/components/accounting/charts/bulletOption';
import { DEFAULT_PALETTE } from '@/components/accounting/charts/chartTypes';

const FT = 'aaaaaaaa-0000-4000-8000-00000000000a';
const HT = 'bbbbbbbb-0000-4000-8000-00000000000b';
const M = '2026-06';
const eff = (cc1: string | null) => ({ cc1, cc2: null, bu: null });

const MEMBERS = buildTrackingMembers({
  groupBy: 'cc1',
  windowMonths: [M],
  actuals: [
    { memberId: FT, month: M, accountType: 'revenue', amount: 150 },
    { memberId: FT, month: M, accountType: 'expense', amount: 50 },
    { memberId: null, month: M, accountType: 'expense', amount: 50 },
    { memberId: HT, month: M, accountType: 'expense', amount: 10 },
    // Outside the window: ignored.
    { memberId: FT, month: '2026-07', accountType: 'revenue', amount: 9999 },
  ],
  budgets: [
    { eff: eff(FT), month: M, accountType: 'revenue', amount: 120 },
    { eff: eff(FT), month: M, accountType: 'expense', amount: 40 },
    { eff: eff(HT), month: M, accountType: 'expense', amount: 0 },
  ],
  names: new Map([[FT, { code: 'FT', name: 'Fibertime' }], [HT, { code: 'HT', name: 'Hometech' }]]),
});

describe('buildTrackingMembers', () => {
  it("is each member's net profit, the untagged remainder last", () => {
    expect(MEMBERS).toEqual([
      { memberId: FT, code: 'FT', name: 'Fibertime', actual: 100, budget: 80, variance: 20, favourable: true },
      { memberId: HT, code: 'HT', name: 'Hometech', actual: -10, budget: 0, variance: -10, favourable: false },
      { memberId: null, code: '', name: UNTAGGED_LABEL, actual: -50, budget: null, variance: null, favourable: null },
    ]);
  });
});

describe('toBulletLines', () => {
  const lines = toBulletLines(MEMBERS);

  it('maps a budgeted member onto the row model, variance favourably signed = the movement', () => {
    expect(lines[0]).toEqual({
      account_id: FT, account_code: 'FT', account_name: 'FT Fibertime', account_type: 'revenue',
      budgeted: true, budget_amount: 80, actual_amount: 100, variance: 20, movement: 20,
      variance_pct: 25, movement_pct: 25, favourable: true,
    });
  });

  it('a budget of zero is budgeted (no %); no budget is unbudgeted and unjudged', () => {
    expect(lines[1]).toMatchObject({ budgeted: true, budget_amount: 0, variance: -10, movement: -10, variance_pct: null, favourable: false });
    expect(lines[2]).toMatchObject({
      account_id: 'untagged', account_name: UNTAGGED_LABEL, budgeted: false, budget_amount: 0,
      variance: -50, movement: -50, variance_pct: null, movement_pct: null, favourable: null,
    });
  });

  it('the bullet chart draws the budgeted members only, by their labels', () => {
    const option = buildBudgetBulletOption(lines, DEFAULT_PALETTE) as { yAxis: { data: string[] } };
    expect([...option.yAxis.data].sort()).toEqual(['FT Fibertime', 'HT Hometech']);
  });
});

describe('review round 2', () => {
  it('A1: a window month in a year with no version leaves every member without a budget; no bullet is drawn', () => {
    const members = buildTrackingMembers({
      groupBy: 'cc1', windowMonths: [M, '2026-07'], noVersionMonths: ['2026-07'],
      actuals: [{ memberId: FT, month: M, accountType: 'revenue', amount: 150 }, { memberId: null, month: '2026-07', accountType: 'expense', amount: 5 }],
      budgets: [{ eff: eff(FT), month: M, accountType: 'revenue', amount: 120 }],
      names: new Map([[FT, { code: 'FT', name: 'Fibertime' }]]),
    });
    expect(members.map((m) => [m.name, m.actual, m.budget, m.variance, m.favourable])).toEqual([
      ['Fibertime', 150, null, null, null], [UNTAGGED_LABEL, -5, null, null, null],
    ]);
    const lines = toBulletLines(members);
    expect(lines.every((l) => !l.budgeted)).toBe(true);
    const option = buildBudgetBulletOption(lines, DEFAULT_PALETTE) as { yAxis: { data: string[] }; series: Array<{ data: unknown[] }> };
    expect(option.yAxis.data).toEqual([]);
    for (const series of option.series) expect(series.data).toEqual([]);
  });

  it('L2: members with the same code are ordered by id, whatever order they arrive in', () => {
    const Z = 'ffffffff-0000-4000-8000-00000000000f';
    const A0 = '00000000-0000-4000-8000-000000000001';
    const run = (ids: string[]) => buildTrackingMembers({
      groupBy: 'cc1', windowMonths: [M],
      actuals: ids.map((id) => ({ memberId: id, month: M, accountType: 'revenue' as const, amount: 1 })),
      budgets: [],
      names: new Map([[Z, { code: 'DUP', name: 'Z' }], [A0, { code: 'DUP', name: 'A' }]]),
    }).map((m) => m.memberId);
    expect(run([Z, A0])).toEqual([A0, Z]);
    expect(run([A0, Z])).toEqual([A0, Z]);
  });
});

describe('review round 3', () => {
  it("R5: members come in the ledger's order (ORDER BY code, id) when it is given, mixed case included", () => {
    // Ids chosen so that neither an id sort nor a code-unit sort gives the ledger's order (review r4).
    const aa = 'cccccccc-0000-4000-8000-0000000000cc'; // 'bt-aa': first in en_US, last by id
    const ft = 'bbbbbbbb-0000-4000-8000-0000000000bb'; // 'BT-FT'
    const zz = 'aaaaaaaa-0000-4000-8000-0000000000aa'; // 'bt-zz': last in en_US, first by id
    // Postgres en_US: 'bt-aa' < 'BT-FT' < 'bt-zz'; by id: zz, ft, aa; by code units: 'BT-FT', 'bt-aa', 'bt-zz'.
    const members = buildTrackingMembers({
      groupBy: 'cc1', windowMonths: [M],
      actuals: [ft, zz, aa, null].map((id) => ({ memberId: id, month: M, accountType: 'revenue' as const, amount: 1 })),
      budgets: [],
      names: new Map([[aa, { code: 'bt-aa', name: 'A' }], [ft, { code: 'BT-FT', name: 'B' }], [zz, { code: 'bt-zz', name: 'C' }]]),
      order: [aa, ft, zz],
    });
    expect(members.map((m) => m.code)).toEqual(['bt-aa', 'BT-FT', 'bt-zz', '']);
  });
});

describe('review round 5', () => {
  it('G1: with a partial line in the window (budgetAbsent) no member carries a budget', () => {
    const members = buildTrackingMembers({
      groupBy: 'cc1', windowMonths: [M], budgetAbsent: true,
      actuals: [{ memberId: FT, month: M, accountType: 'revenue', amount: 150 }],
      budgets: [{ eff: eff(FT), month: M, accountType: 'revenue', amount: 120 }],
      names: new Map([[FT, { code: 'FT', name: 'Fibertime' }]]),
    });
    expect(members.map((m) => [m.name, m.actual, m.budget, m.variance, m.favourable])).toEqual([['Fibertime', 150, null, null, null]]);
  });
});

describe('review round 6', () => {
  it('F1: a member budgeted in some window years and not another leaves every member without a budget', () => {
    const P1 = 'cccccccc-0000-4000-8000-0000000000c1';
    const P2 = 'dddddddd-0000-4000-8000-0000000000d2';
    const base = {
      groupBy: 'cc2' as const, windowMonths: ['2027-04', '2027-05'],
      windowYears: [{ fiscalYear: 2027, months: ['2027-04'] }, { fiscalYear: 2028, months: ['2027-05'] }],
      actuals: [P1, P2].map((id) => ({ memberId: id, month: '2027-04', accountType: 'revenue' as const, amount: 10 })),
      names: new Map([[P1, { code: 'P1', name: 'Project 1' }], [P2, { code: 'P2', name: 'Project 2' }]]),
    };
    const e2 = (cc2: string) => ({ cc1: null, cc2, bu: null });
    // P1 in FY2027 only; P2 in both years.
    const partial = buildTrackingMembers({ ...base, budgets: [
      { eff: e2(P1), month: '2027-04', accountType: 'revenue', amount: 5 },
      { eff: e2(P2), month: '2027-04', accountType: 'revenue', amount: 5 }, { eff: e2(P2), month: '2027-05', accountType: 'revenue', amount: 5 },
    ] });
    for (const m of partial) expect([m.name, m.budget, m.variance, m.favourable]).toEqual([m.name, null, null, null]);
    // Both members whole: budgets stay.
    const whole = buildTrackingMembers({ ...base, budgets: [
      { eff: e2(P1), month: '2027-04', accountType: 'revenue', amount: 5 }, { eff: e2(P1), month: '2027-05', accountType: 'revenue', amount: 5 },
      { eff: e2(P2), month: '2027-04', accountType: 'revenue', amount: 5 }, { eff: e2(P2), month: '2027-05', accountType: 'revenue', amount: 5 },
    ] });
    expect(whole.map((m) => m.budget)).toEqual([10, 10]);
  });
});
