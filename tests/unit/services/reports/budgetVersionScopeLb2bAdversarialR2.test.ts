/**
 * LB-2(b) regression tests, #1124 round 2 (adopted from the adversarial review of 00fa209c1). Same
 * harness as budgetVersionScopeLb2bAdversarial.test.ts: the real facade/range/core, run with master's
 * scope (helpers/budgetVersionScopeMaster.ts) and the live one. The registry answers below were proved
 * on PG16 with migration 940's fiscal_year_template: fixtures/lb2b-pg-proof-r2.txt. `stored: false` =
 * a template year (no fiscal_years row).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SALES, W, fakeSql, resetLedger } from './helpers/budgetLedgerFake';

const impl = { old: false };
const GAP_ERRORS: Record<string, string> = {};

vi.mock('@/lib/neon', () => ({ sql: (s: TemplateStringsArray, ...v: unknown[]) => fakeSql(s, ...v) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@/modules/accounting/services/gl/fiscalYearRegistry', async (orig) => ({
  ...(await orig<object>()),
  fiscalYearForDate: (_c: string, d: string) => {
    if (GAP_ERRORS[d]) return Promise.reject(Object.assign(new Error(GAP_ERRORS[d]), { code: 'P0001' }));
    const y = W.years.find((r) => d >= r.startDate && d <= r.endDate);
    if (!y) return Promise.reject(new Error(`fiscalYearForDate: no fiscal year for company x on ${d}`));
    return Promise.resolve({ ...y, id: `fy${y.fiscalYear}`, status: 'open', kind: 'normal', stored: y.stored !== false, assumed: false });
  },
  getFiscalYear: (_c: string, fiscalYear: number) => Promise.resolve(W.years.find((y) => y.fiscalYear === fiscalYear) ?? null),
}));
vi.mock('@/modules/accounting/services/budgets/budgetVersionScope', async (orig) => {
  const nu = await orig<typeof import('@/modules/accounting/services/budgets/budgetVersionScope')>();
  const old = await import('./helpers/budgetVersionScopeMaster');
  return {
    ...nu,
    primaryVersionScopeAndYears: (c: string, s: string, e: string) =>
      (impl.old ? old.primaryVersionScopeAndYears : nu.primaryVersionScopeAndYears)(c, s, e),
  };
});

import { getBudgetVariance } from '@/modules/accounting/services/reports/budgetVarianceService';
import { buildRangeTracking } from '@/modules/accounting/services/budgets/tracking/trackingRange';

const CO = 'cccccccc-0000-4000-8000-00000000000c';
const settle = async <T>(p: () => Promise<T>) => {
  try { return { ok: true as const, value: await p() }; } catch (e) { return { ok: false as const, error: String((e as Error).message), status: (e as { status?: number }).status }; }
};
const both = async <T>(p: () => Promise<T>) => {
  impl.old = true; const before = await settle(p);
  impl.old = false; const after = await settle(p);
  return { before, after };
};
const budget = (r: { lines: Array<{ account_id: string; budget_amount: number }> }, id: string) => r.lines.find((l) => l.account_id === id)?.budget_amount;

beforeEach(() => { resetLedger(); for (const k of Object.keys(GAP_ERRORS)) delete GAP_ERRORS[k]; impl.old = false; });

// Co3 (PG-proved): the last STORED year ends mid-month (FY2027 = 15 Mar 2026..14 Mar 2027, start month 3);
// every later year is a template ending on the 14th.
const postTransition = () => {
  W.years = [
    { fiscalYear: 2027, startDate: '2026-03-15', endDate: '2027-03-14' },
    { fiscalYear: 2028, startDate: '2027-03-15', endDate: '2028-03-14', stored: false },
    { fiscalYear: 2029, startDate: '2028-03-15', endDate: '2029-03-14', stored: false },
  ];
  // FY2028's grid is Mar 2027..Mar 2028 (gridSave: budgetMonthKeysInWindow(start, end)); writing a
  // template year's budget never stores the year. The view budget_primary_month_amounts and rehome
  // file March 2028 under fiscal_year_for_date('2028-03-01') = FY2028.
  W.versions = { 2028: 'v28' };
  W.cells = [
    { version: 'v28', account: SALES, month: '2027-04', amount: 100 },
    { version: 'v28', account: SALES, month: '2028-03', amount: 300 },
  ];
};

describe('R2-1 (regression at 00fa209c1): a template year keeps its mid-month last month when the next year is a template too', () => {
  it('FY2028\'s own window reads the March 2028 its grid holds (was 100 at 00fa209c1; must be master\'s 400)', async () => {
    postTransition();
    const { before, after } = await both(() => getBudgetVariance(CO, '2027-03-15', '2028-03-14'));
    expect(before.ok && budget(before.value, SALES)).toBe(400);
    expect(after.ok && budget(after.value, SALES)).toBe(400); // 00fa209c1: 100 (March 2028 read from template FY2029, no version)
  });
  it('a window inside FY2028 by date lists only FY2028 (00fa209c1 added FY2029, reported absent)', async () => {
    postTransition();
    const { before, after } = await both(() => getBudgetVariance(CO, '2027-04-01', '2028-03-10', { partialWindow: 'absent' }));
    const pick = (r: typeof before) => (r.ok ? { years: r.value.years, budgetAbsentYears: r.value.budgetAbsentYears } : r);
    expect(pick(before)).toEqual({ years: [2028], budgetAbsentYears: [] });
    expect(pick(after)).toEqual({ years: [2028], budgetAbsentYears: [] }); // 00fa209c1: years [2028, 2029], budgetAbsentYears [2029]
  });
});

describe('R2-2 (regression at 00fa209c1): the owed-month walk never looks up a date the registry cannot place', () => {
  it('a window inside ONE template year answers (was a 400 at 00fa209c1; master answers)', async () => {
    // Co4 (PG-proved): stored FY2027 ends 14 Mar 2027; template FY2028 15 Mar 2027..14 Mar 2028;
    // stored FY2029 starts 1 Jun 2028; fiscal_year_for_date('2028-03-15') raises no free label.
    W.years = [
      { fiscalYear: 2027, startDate: '2026-03-15', endDate: '2027-03-14' },
      { fiscalYear: 2028, startDate: '2027-03-15', endDate: '2028-03-14', stored: false },
      { fiscalYear: 2029, startDate: '2028-06-01', endDate: '2029-05-31' },
    ];
    GAP_ERRORS['2028-03-15'] = 'fiscal_year_template: no free label for the year holding 2028-03-15 (between FY2027 and FY2029)';
    W.versions = { 2028: 'v28' };
    W.cells = [{ version: 'v28', account: SALES, month: '2027-04', amount: 100 }];
    const { before, after } = await both(() => getBudgetVariance(CO, '2027-04-01', '2028-03-10'));
    expect(before.ok).toBe(true);
    expect(after).toMatchObject({ ok: true }); // 00fa209c1: 400 No financial year can be placed for that date
  });
});

describe('pre-existing limitation, pinned (master behaves the same; out of LB-2(b) scope)', () => {
  it('March in a gap company: from the 10th it is FY2027\'s; from the 1st (and remainingFor\'s keys) a 400, as on master', async () => {
    W.years = [{ fiscalYear: 2026, startDate: '2025-02-26', endDate: '2026-02-25' }, { fiscalYear: 2027, startDate: '2026-03-05', endDate: '2027-03-04' }];
    GAP_ERRORS['2026-03-01'] = 'fiscal_year_template: no free label for the year holding 2026-03-01 (between FY2026 and FY2027)';
    W.versions = { 2027: 'v27' };
    W.cells = [{ version: 'v27', account: SALES, month: '2026-03', amount: 50 }];
    const tenth = await settle(() => getBudgetVariance(CO, '2026-03-10', '2026-03-31'));
    expect(tenth.ok && budget(tenth.value, SALES)).toBe(50);
    // Follow-up, not this PR: the window from the 1st looks the 1st up in the gap and raises, on master too.
    const { before, after } = await both(() => getBudgetVariance(CO, '2026-03-01', '2026-03-31'));
    expect([before.ok, after.ok]).toEqual([false, false]);
    expect(after).toEqual(before);
  });
});
