/**
 * Stored inputs (storeTypes, migration 999i) -> the engine's inputs (types.ts `ManualItem`, `Override`;
 * payDates.ts `PayDay`). Pure.
 *
 * Rules (lead's ruling 2026-11-16):
 *   - amountCents = round(amount x 100); an item's payment is negative, a receipt positive.
 *   - An override's weekIndex counts Mondays from the horizon's first Monday (buildWeeks(today)[0]); a week
 *     before it (scrolled into the past) or past the last week is dropped.
 *   - Overrides keep the order they arrive in: the repo lists them in application order (ORDER BY applied_at,
 *     id in the database; a note-only edit keeps its place). Never re-sorted here: ISO strings hold
 *     milliseconds only, the database's microseconds would tie and reorder.
 *   - set/add amounts are stored in the line's own sign and pass through. A move_to amount is stored as a
 *     magnitude (> 0) and passes through positive; null = the whole cell. The engine applies a move_to
 *     amount in the cell's sign.
 */
import type { PayDay } from './payDates';
import type { ManualItem, Override } from './types';
import { FORECAST_WEEKS } from './types';
import { buildWeeks, daysBetween } from './weeks';
import { toCents } from './lines';
import type { ManualCashItem, PayDayRule } from './storeTypes';
import type { StoredOverride } from './overridesRepo';

/** The Monday of `today`'s week: the horizon's week 0. */
export const horizonStart = (today: string): string => buildWeeks(today)[0]!.start;

/** Whole weeks from the horizon's first Monday to `monday` (may be negative or past the horizon). */
export const weekOffset = (firstMonday: string, monday: string): number => Math.floor(daysBetween(firstMonday, monday) / 7);

/** The engine's own rand -> cents (one implementation). */
export { toCents };

export function toEngineManualItems(items: readonly ManualCashItem[]): ManualItem[] {
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
 * The overrides inside the horizon, in the order given (the repo's application order). A move_to whose target
 * lies outside it is passed on (the engine skips it with an `override_skipped` warning, so the user sees why).
 */
export function toEngineOverrides(overrides: readonly StoredOverride[], today: string): Override[] {
  const first = horizonStart(today);
  const out: Override[] = [];
  for (const o of overrides) {
    const weekIndex = weekOffset(first, o.weekStart);
    if (weekIndex < 0 || weekIndex >= FORECAST_WEEKS) continue;
    const e: Override = { lineKey: o.lineKey, weekIndex, mode: o.mode, amountCents: o.amount === null ? null : toCents(o.amount) };
    if (o.mode === 'move_to' && o.targetWeekStart) e.targetWeek = weekOffset(first, o.targetWeekStart);
    out.push(e);
  }
  return out;
}

export function toEnginePayDay(rule: PayDayRule): PayDay {
  return rule.kind === 'last_working_day' ? 'last_working_day' : rule.day;
}
