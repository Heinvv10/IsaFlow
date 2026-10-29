/**
 * Bullets per cost centre (budgets P3 spec §2.4 last rule, §2.7). Pure.
 *
 * Unfiltered, grouped by CC1, CC2 or BU: one figure per member that has a
 * budget or actuals in the window, plus an "Untagged / company-level" member
 * (memberId null) carrying the actuals with no member and every budget row
 * with no effective member at that level (company level, another level's
 * grain, a CC2 with no FNO under CC1) — the same rule as `dimensionPnlService`'s
 * UNTAGGED column. The members therefore PARTITION the company figure.
 *
 * Over a window with a month in a year with no version, or with a line whose
 * budget covers part of the window (so NP's budget is absent), the members
 * carry no budget at all: they partition NP, and a partial-window budget is
 * not one.
 *
 * The figure is each member's NET PROFIT contribution (revenue − expense, so
 * favourable when ≥ 0, like every profit total): a cost centre holds both
 * income and cost, and only their net partitions the company's net profit.
 *
 * `toBulletLines` maps the members to P0's `BudgetVsActualLine` for the
 * unchanged `BudgetBulletRow`: `account_name` is the member label and
 * `variance` the favourably signed figure `bulletOption` reads (for a profit
 * figure it equals the movement).
 */
import type { BudgetVsActualLine } from '@/modules/accounting/services/reports/budgetVsActualLines';
import type { EffDims } from './trackingDimRollup';
import { fromCents, toCents } from '../grid/cents';
import { isFavourable, pctOf } from './trackingLines';
import type { TrackingGroupBy, TrackingMember, WindowYear } from './trackingTypes';

export interface MemberActual { memberId: string | null; month: string; accountType: 'revenue' | 'expense'; amount: number }
export interface MemberBudget { eff: EffDims; month: string; accountType: 'revenue' | 'expense'; amount: number; accountId: string }

export const UNTAGGED_LABEL = 'Untagged / company level';

/**
 * Review r6 F1, the lines' cross-year rule at a member's own grain: over a window touching more
 * than one financial year, a member (or the untagged remainder) with budget rows for some ACCOUNT in
 * some years' window months and none for it in another's has a partial-window budget (per member and
 * account, review r7, as the lines are per account). Any such member
 * leaves every member without one, so the members keep partitioning NP.
 */
function memberPartial(groupBy: TrackingGroupBy, budgets: readonly MemberBudget[], windowYears: readonly WindowYear[]): boolean {
  const years = windowYears.filter((y) => y.months.length > 0);
  if (years.length < 2) return false;
  const yearOf = new Map(years.flatMap((y) => y.months.map((m) => [m, y.fiscalYear] as const)));
  const seen = new Map<string, Set<number>>();
  for (const b of budgets) {
    const y = yearOf.get(b.month);
    if (y === undefined) continue;
    // Per (member, account), as the lines' rule is per account (review r7): budgeted in both years
    // on different accounts is still a member budget for part of the window.
    const key = `${b.eff[groupBy] ?? ''}|${b.accountId}`;
    const ys = seen.get(key) ?? new Set<number>();
    ys.add(y);
    seen.set(key, ys);
  }
  return [...seen.values()].some((ys) => ys.size < years.length);
}

export function buildTrackingMembers(input: {
  groupBy: TrackingGroupBy;
  windowMonths: readonly string[];
  actuals: readonly MemberActual[];
  budgets: readonly MemberBudget[];
  names: ReadonlyMap<string, { code: string; name: string }>;
  /** Window months in a year with no version: any of them leaves every member without a budget (as the lines). */
  noVersionMonths?: readonly string[];
  /** Member ids in the masters' order (`readMemberOrder`, ORDER BY code, id in SQL). */
  order?: readonly string[];
  /** The window's profit budget is a partial-window figure (a partial line, review r5 G1): members partition it, so none has a budget. */
  budgetAbsent?: boolean;
  /** The window's financial years with their window months, for the member-level cross-year rule (review r6 F1). */
  windowYears?: readonly WindowYear[];
}): TrackingMember[] {
  const inWindow = new Set(input.windowMonths);
  const budgetAbsent = input.budgetAbsent === true || input.windowMonths.some((m) => input.noVersionMonths?.includes(m))
    || memberPartial(input.groupBy, input.budgets, input.windowYears ?? []);
  const acc = new Map<string | null, { actual: number; budget: number | null }>();
  const slot = (id: string | null) => {
    let s = acc.get(id);
    if (!s) acc.set(id, (s = { actual: 0, budget: null }));
    return s;
  };
  const signed = (type: 'revenue' | 'expense', amount: number) => (type === 'revenue' ? toCents(amount) : -toCents(amount));
  for (const a of input.actuals) {
    if (inWindow.has(a.month)) slot(a.memberId).actual += signed(a.accountType, a.amount);
  }
  for (const b of input.budgets) {
    if (budgetAbsent || !inWindow.has(b.month)) continue;
    const s = slot(b.eff[input.groupBy]);
    s.budget = (s.budget ?? 0) + signed(b.accountType, b.amount);
  }
  const members: TrackingMember[] = [];
  for (const [memberId, s] of acc) {
    if (s.actual === 0 && s.budget === null) continue;
    const named = memberId === null ? null : input.names.get(memberId);
    const variance = s.budget === null ? null : s.actual - s.budget;
    members.push({
      memberId,
      code: memberId === null ? '' : named?.code ?? memberId,
      name: memberId === null ? UNTAGGED_LABEL : named?.name ?? 'Unknown member',
      actual: fromCents(s.actual),
      budget: s.budget === null ? null : fromCents(s.budget),
      variance: variance === null ? null : fromCents(variance),
      favourable: variance === null ? null : isFavourable('income', variance),
    });
  }
  // A total order: the masters' SQL order (code, then id, in the ledger's collation); a member with
  // no master row (an unknown id) after them by id; the untagged remainder last.
  const rank = new Map((input.order ?? []).map((id, i) => [id, i]));
  const keyOf = (m: TrackingMember): [number, number, string] =>
    (m.memberId === null ? [2, 0, ''] : rank.has(m.memberId) ? [0, rank.get(m.memberId) ?? 0, ''] : [1, 0, m.memberId]);
  return members.sort((x, y) => {
    const [xg, xr, xi] = keyOf(x);
    const [yg, yr, yi] = keyOf(y);
    if (xg !== yg) return xg - yg;
    if (xr !== yr) return xr - yr;
    return xi < yi ? -1 : xi > yi ? 1 : 0;
  });
}

/** The members as P0 row-model lines, for `BudgetBulletRow`. */
export function toBulletLines(members: readonly TrackingMember[]): BudgetVsActualLine[] {
  return members.map((m) => {
    const budgeted = m.budget !== null;
    const budget = m.budget ?? 0;
    const movement = m.variance ?? fromCents(toCents(m.actual) - toCents(budget));
    const pct = budgeted ? pctOf(toCents(movement), toCents(budget)) : null;
    return {
      account_id: m.memberId ?? 'untagged',
      account_code: m.code,
      account_name: m.code ? `${m.code} ${m.name}` : m.name,
      account_type: 'revenue',
      budgeted,
      budget_amount: budget,
      actual_amount: m.actual,
      variance: movement,
      movement,
      variance_pct: pct,
      movement_pct: pct,
      favourable: m.favourable,
    };
  });
}
