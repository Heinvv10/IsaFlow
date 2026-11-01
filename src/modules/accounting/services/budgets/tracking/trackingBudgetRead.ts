/**
 * The budget side of the tracking engine (budgets P3 spec §2.2, §2.5): which
 * version each financial year reads, and its stored amounts per account x
 * month x grain.
 *
 * Versions (contract: "readers use the primary"): with no `versionId` each
 * financial year the read covers contributes its PRIMARY version's months (a
 * year with none contributes nothing), the rule of
 * `budgets/budgetVersionScope.primaryVersionScopeAndYears`, applied to the years the
 * window already resolved. A named version must belong to the company (else 404,
 * through `versionYear`), and every month of the window must lie in that
 * version's year, else 400 "version X is FY2027; the window reaches FY2028".
 *
 * The read covers the window AND every month of FY* (the year holding the
 * window's end), because the projection needs FY*'s whole budget.
 *
 * Rows come back at their stored grain (cc1 / cc2 / bu, at most one, migration
 * 947); classifying them against a filter is `trackingDimRollup`'s job. Never
 * summed across grains here: a roll-up is computed, never stored.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { budgetMonthBounds, budgetMonthKeysInWindow, monthKeyToDate } from '@/modules/accounting/services/reports/budgetPeriodWindow';
import { versionYear, type VersionScope } from '../budgetVersionScope';
import { mapRegistryMiss } from './trackingWindow';
import type { AccountMeta } from './trackingLines';
import { TrackingError, type TrackingVersionRef, type TrackingWindow, type WindowYear } from './trackingTypes';

export interface BudgetRow extends AccountMeta {
  /** 'YYYY-MM'. */
  month: string;
  cc1Id: string | null;
  cc2Id: string | null;
  buId: string | null;
  amount: number;
}

export interface TrackingVersions {
  scope: VersionScope[];
  /** FY*'s version; null when FY* has none. */
  version: TrackingVersionRef | null;
  /** Every year of a cross-FY window that has a version. */
  versionsByFy?: Record<number, { id: string; name: string; kind: string; status: string; empty?: true }>;
  /** Window years (and FY*) without a version. The service widens this to every budget-ABSENT year once the budget read is in (`budgetAbsentYears`). */
  noVersionYears: number[];
}

export async function versionHeads(companyId: string, ids: string[]): Promise<Map<string, TrackingVersionRef>> {
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id::TEXT AS id, name, kind, status, is_primary
      FROM budget_versions
     WHERE company_id = ${companyId}::UUID AND id = ANY(${ids}::UUID[])
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.id), {
    id: String(r.id), name: String(r.name), kind: String(r.kind), status: String(r.status), isPrimary: Boolean(r.is_primary),
  }]));
}

/**
 * The months each version contributes: every window year's months inside the window, and FY*
 * whole (the projection reads its full budget). Built from the window the registry already
 * resolved (`window.years`, `window.fy`), so the registry is not walked twice.
 */
function scopeYears(window: TrackingWindow): Array<{ fiscalYear: number; first: string; last: string }> {
  const fy = window.fy;
  const out = window.years
    .filter((y) => y.fiscalYear !== fy.fiscalYear && y.months.length > 0)
    .map((y) => ({ fiscalYear: y.fiscalYear, first: monthKeyToDate(y.months[0]!), last: monthKeyToDate(y.months[y.months.length - 1]!) }));
  const whole = budgetMonthBounds(fy.startDate, fy.endDate);
  if (whole) out.push({ fiscalYear: fy.fiscalYear, ...whole });
  return out;
}

type ClassedMonth = { month: string; cls: 'included' | 'coarser' | 'other' };
type AbsentWindow = { years: readonly WindowYear[]; fy: { fiscalYear: number; startDate: string; endDate: string } };

/** Every year the budget is judged over: the window's, and FY* when it lies outside (judged over its whole year, as the projection reads it). */
function judgedYears(window: AbsentWindow): WindowYear[] {
  return window.years.some((y) => y.fiscalYear === window.fy.fiscalYear)
    ? [...window.years]
    : [...window.years, { fiscalYear: window.fy.fiscalYear, months: budgetMonthKeysInWindow(window.fy.startDate, window.fy.endDate) }];
}

/**
 * Pure (review r3 R9, r4 E1-E3, r2 R8): the years the WINDOW has no budget for. A year is budget-absent
 * when it has no version, or when its version contributes no row to the scoped budget read
 * (`readTrackingBudgets`: income-statement accounts, the version's own months) within that year's
 * window months. An "any row" check would be fooled by a row outside the window, on a balance-sheet
 * account, or dated in another year's month. It is judged BEFORE the dimension filter: a row the
 * filter classes as other or coarser still means the year HAS a budget (not at this filter, which
 * `budgetOutsideFilterYears` says), so "no budget for FY2027" is never printed for a year whose budget
 * is simply set at another cost centre.
 */
export function budgetAbsentYears(
  window: AbsentWindow,
  scope: readonly VersionScope[],
  rows: ReadonlyArray<ClassedMonth>,
): number[] {
  const budgeted = new Set(rows.map((r) => r.month));
  return judgedYears(window)
    .filter((y) => {
      const version = scope.find((sc) => sc.fiscalYear === y.fiscalYear)?.versionId ?? null;
      return version === null || !y.months.some((m) => budgeted.has(m));
    })
    .map((y) => y.fiscalYear);
}

/**
 * Pure (review r2, R8): the years that HAVE a budget in the window, none of which is at the filter:
 * every row of the year's window months is another dimension's (class other). A row set above the
 * filter (coarser) is the unallocated footer's to say, and an included row is the budget itself.
 */
export function budgetOutsideFilterYears(
  window: AbsentWindow,
  scope: readonly VersionScope[],
  rows: ReadonlyArray<ClassedMonth>,
): number[] {
  const absent = new Set(budgetAbsentYears(window, scope, rows));
  const atFilter = new Set(rows.filter((r) => r.cls !== 'other').map((r) => r.month));
  return judgedYears(window)
    .filter((y) => !absent.has(y.fiscalYear) && !y.months.some((m) => atFilter.has(m)))
    .map((y) => y.fiscalYear);
}

/**
 * A named version's scope over the window's years: the version must be the company's (404 through
 * `versionYear`) and every year the window reaches must be its own (400 "version X is FY2027; the
 * window reaches FY2028"). The Budget vs Actual report and the date-range entry point both use it.
 */
export async function namedVersionScopeOf(
  companyId: string,
  versionId: string,
  years: ReadonlyArray<{ fiscalYear: number; first: string; last: string }>,
): Promise<VersionScope[]> {
  const year = await mapRegistryMiss(() => versionYear(companyId, versionId));
  const reaches = years.map((y) => y.fiscalYear).filter((y) => y !== year.fiscalYear);
  if (reaches.length > 0) {
    throw new TrackingError(400, `version ${versionId} is FY${year.fiscalYear}; the window reaches FY${reaches[0]}`);
  }
  return years.map((y) => ({ ...y, versionId }));
}

/** The versions a window reads; `versionId` is looked up under the company (404 when it is not its own). */
export async function resolveTrackingVersions(companyId: string, window: TrackingWindow, versionId?: string): Promise<TrackingVersions> {
  const fy = window.fy;
  const years = scopeYears(window);
  let scope: VersionScope[];
  if (versionId) {
    // The window lies inside the version's year, so FY* is that year: one scope entry, the whole year.
    scope = await namedVersionScopeOf(companyId, versionId, years);
  } else {
    const prim = (await sql`
      SELECT id::TEXT AS id, fiscal_year FROM budget_versions
       WHERE company_id = ${companyId}::UUID AND is_primary AND fiscal_year = ANY(${years.map((y) => y.fiscalYear)}::INT[])
    `) as DbRow[];
    const byLabel = new Map(prim.map((r) => [Number(r.fiscal_year), String(r.id)]));
    scope = years.map((y) => ({ ...y, versionId: byLabel.get(y.fiscalYear) ?? null }));
  }
  const ids = [...new Set(scope.map((s) => s.versionId).filter((v): v is string => v !== null))];
  const heads = await versionHeads(companyId, ids);
  const byYear = new Map(scope.map((s) => [s.fiscalYear, s.versionId]));
  const fyVersion = byYear.get(fy.fiscalYear) ?? null;
  const out: TrackingVersions = {
    scope,
    version: fyVersion === null ? null : heads.get(fyVersion) ?? null,
    noVersionYears: scope.filter((sc) => sc.versionId === null).map((sc) => sc.fiscalYear),
  };
  if (window.years.length > 1) {
    out.versionsByFy = {};
    for (const y of window.years) {
      const vid = byYear.get(y.fiscalYear) ?? null;
      const head = vid === null ? undefined : heads.get(vid);
      if (head) out.versionsByFy[y.fiscalYear] = { id: head.id, name: head.name, kind: head.kind, status: head.status };
    }
  }
  return out;
}

/** Stored amounts of the scoped versions' months, revenue and expense accounts only, company-scoped. */
export async function readTrackingBudgets(companyId: string, scope: readonly VersionScope[]): Promise<BudgetRow[]> {
  const live = scope.filter((s): s is VersionScope & { versionId: string } => s.versionId !== null);
  if (live.length === 0) return [];
  const rows = (await sql`
    SELECT ga.id::TEXT AS account_id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype,
           to_char(bm.month, 'YYYY-MM') AS month,
           bm.cc1_id::TEXT AS cc1_id, bm.cc2_id::TEXT AS cc2_id, bm.bu_id::TEXT AS bu_id,
           SUM(bm.amount)::TEXT AS amount
      FROM budget_month_amounts bm
      JOIN unnest(${live.map((s) => s.versionId)}::UUID[], ${live.map((s) => s.first)}::DATE[], ${live.map((s) => s.last)}::DATE[])
        AS sc(version_id, first_month, last_month)
        ON bm.version_id = sc.version_id AND bm.month >= sc.first_month AND bm.month <= sc.last_month
      JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
     WHERE bm.company_id = ${companyId}::UUID
       AND ga.account_type IN ('revenue', 'expense')
     GROUP BY ga.id, ga.account_code, ga.account_name, ga.account_type, ga.account_subtype, 6, bm.cc1_id, bm.cc2_id, bm.bu_id
     ORDER BY ga.account_code, 6
  `) as DbRow[];
  const text = (v: unknown): string | null => (v == null ? null : String(v).toLowerCase());
  return rows.map((r) => ({
    accountId: String(r.account_id).toLowerCase(),
    accountCode: String(r.account_code),
    accountName: String(r.account_name),
    accountType: String(r.account_type) === 'revenue' ? 'revenue' : 'expense',
    accountSubtype: r.account_subtype == null ? null : String(r.account_subtype),
    month: String(r.month),
    cc1Id: text(r.cc1_id),
    cc2Id: text(r.cc2_id),
    buId: text(r.bu_id),
    amount: Number(r.amount),
  }));
}
