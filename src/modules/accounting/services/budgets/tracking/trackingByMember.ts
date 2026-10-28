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
 * Over a window with a month in a year with no version the members carry no
 * budget at all (the lines' F1 rule): a partial-window budget is not one.
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
import type { TrackingGroupBy, TrackingMember } from './trackingTypes';

export interface MemberActual { memberId: string | null; month: string; accountType: 'revenue' | 'expense'; amount: number }
export interface MemberBudget { eff: EffDims; month: string; accountType: 'revenue' | 'expense'; amount: number }

export const UNTAGGED_LABEL = 'Untagged / company level';

export function buildTrackingMembers(input: {
  groupBy: TrackingGroupBy;
  windowMonths: readonly string[];
  actuals: readonly MemberActual[];
  budgets: readonly MemberBudget[];
  names: ReadonlyMap<string, { code: string; name: string }>;
  /** Window months in a year with no version: any of them leaves every member without a budget (as the lines). */
  noVersionMonths?: readonly string[];
}): TrackingMember[] {
  const inWindow = new Set(input.windowMonths);
  const budgetAbsent = input.windowMonths.some((m) => input.noVersionMonths?.includes(m));
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
  // A total order: members by code, then id (two masters can share a code); the untagged remainder last.
  const key = (m: TrackingMember) => [m.code, m.memberId ?? ''] as const;
  return members.sort((x, y) => {
    if (x.memberId === null || y.memberId === null) return x.memberId === null ? (y.memberId === null ? 0 : 1) : -1;
    const [xc, xi] = key(x);
    const [yc, yi] = key(y);
    if (xc !== yc) return xc < yc ? -1 : 1;
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
