/**
 * Stored inputs (storeTypes, migration 999i) -> the engine's inputs (cashForecast13/types.ts, PR 1). Pure.
 *
 * The engine types are copied here until PR 1 merges; then merge origin/master into this branch and replace
 * `EngineManualItem` / `EngineOverride` / `EnginePayDay` with imports of `ManualItem`, `Override` (types.ts)
 * and `PayDay` (payDates.ts). Shapes must stay identical.
 *
 * Rules (lead's ruling 2026-11-16):
 *   - amountCents = round(amount x 100); an item's payment is negative, a receipt positive.
 *   - An override's weekIndex counts Mondays from the horizon's first Monday (the Monday of `today`'s week,
 *     as buildWeeks does); a week before it (scrolled into the past) or past week 13 is dropped.
 *   - Overrides keep the order they arrive in: the repo lists them in application order, the last edit last
 *     (ORDER BY applied_at, id in the database; a note-only edit keeps its place). Never re-sorted here: ISO strings hold milliseconds only, the
 *     database's microseconds would tie and reorder.
 *   - set/add amounts are stored in the line's own sign and pass through. A move_to amount is stored as a
 *     magnitude (> 0) and passes through positive; null = the whole cell. The engine applies a move_to
 *     amount in the cell's sign.
 */
import type { ManualCashItem, PayDayRule } from './storeTypes';
import type { StoredOverride } from './overridesRepo';

export const ENGINE_WEEKS = 13;

type EngineCategory = 'customer_receipts' | 'supplier_payments' | 'payroll' | 'sars' | 'loans' | 'other';

export interface EngineManualItem {
  id: string;
  date: string;
  amountCents: number;
  description: string;
  category: EngineCategory;
  repeat?: { frequency: 'weekly' | 'monthly'; until?: string | null } | null;
}

export interface EngineOverride {
  lineKey: string;
  weekIndex: number;
  mode: 'set' | 'add' | 'move_to';
  amountCents?: number | null;
  targetWeek?: number | null;
}

export type EnginePayDay = number | 'last_working_day';

const DAY_MS = 86_400_000;
const utc = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};

/** The Monday of `today`'s week: the horizon's week 0. */
export function horizonStart(today: string): string {
  const t = utc(today);
  const weekday = (new Date(t).getUTCDay() + 6) % 7; // 0 = Monday
  return new Date(t - weekday * DAY_MS).toISOString().slice(0, 10);
}

/** Whole weeks from the horizon's first Monday to `monday` (may be negative or past the horizon). */
export function weekOffset(firstMonday: string, monday: string): number {
  return Math.floor(Math.round((utc(monday) - utc(firstMonday)) / DAY_MS) / 7);
}

export const toCents = (rand: number) => Math.round(rand * 100);

export function toEngineManualItems(items: readonly ManualCashItem[]): EngineManualItem[] {
  return items.map((i) => ({
    id: i.id,
    date: i.date,
    amountCents: (i.direction === 'payment' ? -1 : 1) * toCents(i.amount),
    description: i.description,
    category: i.category,
    repeat: i.repeat === 'none' ? null : { frequency: i.repeat, until: i.repeatUntil },
  }));
}

/**
 * The overrides inside the horizon, in the order given (the repo's application order). A move_to whose target lies outside it is passed
 * on (the engine skips it with an `override_skipped` warning, so the user sees why), not dropped here.
 */
export function toEngineOverrides(overrides: readonly StoredOverride[], today: string): EngineOverride[] {
  const first = horizonStart(today);
  const out: EngineOverride[] = [];
  for (const o of overrides) {
    const weekIndex = weekOffset(first, o.weekStart);
    if (weekIndex < 0 || weekIndex >= ENGINE_WEEKS) continue;
    const e: EngineOverride = { lineKey: o.lineKey, weekIndex, mode: o.mode, amountCents: o.amount === null ? null : toCents(o.amount) };
    if (o.mode === 'move_to' && o.targetWeekStart) e.targetWeek = weekOffset(first, o.targetWeekStart);
    out.push(e);
  }
  return out;
}

export function toEnginePayDay(rule: PayDayRule): EnginePayDay {
  return rule.kind === 'last_working_day' ? 'last_working_day' : rule.day;
}
