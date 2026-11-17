/**
 * Per-company limits on the forecast's stored inputs (security review of the live-only caps):
 *   - LIVE caps (what the engine reads): MAX_ITEMS items that are one-offs from this week's Monday on or repeats
 *     with no end or an end from today on; MAX_OVERRIDES overrides with a week from this Monday on;
 *   - TOTAL caps on every row, live or not (MAX_ITEMS_TOTAL, MAX_OVERRIDES_TOTAL), so dead rows cannot grow
 *     without bound.
 * Every check runs under the per-company advisory lock of its table, held to the end of the request tx, so two
 * concurrent writes at a cap cannot both pass. A 409 says which cap was hit and how many rows count toward it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/types/db';
import { appToday } from '../reports/dueByDateService';
import { horizonStart } from './engineAdapter';
import { CashForecastLimitError } from './storeErrors';
import { MAX_ITEMS, MAX_ITEMS_TOTAL, MAX_OVERRIDES, MAX_OVERRIDES_TOTAL, type ManualItemRepeat } from './storeTypes';

/** Today (the app's SAST day) and this week's Monday. */
export interface LiveWindow { today: string; monday: string }
export function liveWindow(): LiveWindow {
  const today = appToday();
  return { today, monday: horizonStart(today) };
}

/** An item the forecast can still use. */
export function isLiveItem(i: { repeat: ManualItemRepeat; date: string; repeatUntil: string | null }, w: LiveWindow): boolean {
  return i.repeat === 'none' ? i.date >= w.monday : i.repeatUntil === null || i.repeatUntil >= w.today;
}

export async function lockItemWrites(companyId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('cash_forecast_items:' || ${companyId}::uuid::text, 0))`;
}

export async function lockOverrideWrites(companyId: string): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('cash_forecast_overrides:' || ${companyId}::uuid::text, 0))`;
}

/** Room for one more live item; with `newRow`, also for one more row in total. Call under lockItemWrites. */
export async function assertItemRoom(companyId: string, w: LiveWindow, newRow: boolean): Promise<void> {
  const r = ((await sql`
    SELECT COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE CASE WHEN repeat = 'none' THEN expected_date >= ${w.monday}::DATE
                                      ELSE repeat_until IS NULL OR repeat_until >= ${w.today}::DATE END)::int AS live
      FROM cash_forecast_items WHERE company_id = ${companyId}::UUID
  `) as DbRow[])[0];
  const live = Number(r?.live ?? 0), total = Number(r?.total ?? 0);
  if (live >= MAX_ITEMS) {
    throw new CashForecastLimitError(`Live items cap: a company can keep at most ${MAX_ITEMS} live expected cash items and this one has ${live} live; remove or end some first`);
  }
  if (newRow && total >= MAX_ITEMS_TOTAL) {
    throw new CashForecastLimitError(`Total items cap: a company can keep at most ${MAX_ITEMS_TOTAL} expected cash items in all (past ones included) and this one has ${total}; delete old ones first`);
  }
}

/** Room for one more override (a new cell, live by construction). Call under lockOverrideWrites. */
export async function assertOverrideRoom(companyId: string, w: LiveWindow): Promise<void> {
  const r = ((await sql`
    SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE week_start >= ${w.monday}::DATE)::int AS live
      FROM cash_forecast_overrides WHERE company_id = ${companyId}::UUID
  `) as DbRow[])[0];
  const live = Number(r?.live ?? 0), total = Number(r?.total ?? 0);
  if (live >= MAX_OVERRIDES) {
    throw new CashForecastLimitError(`Live overrides cap: a company can keep at most ${MAX_OVERRIDES} live forecast overrides and this one has ${live} live; remove some first`);
  }
  if (total >= MAX_OVERRIDES_TOTAL) {
    throw new CashForecastLimitError(`Total overrides cap: a company can keep at most ${MAX_OVERRIDES_TOTAL} forecast overrides in all (past weeks included) and this one has ${total}; delete old ones first`);
  }
}
