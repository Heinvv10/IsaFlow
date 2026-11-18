/**
 * LEGACY MATCH ONLY. A "marked filed" row made before migration 999c has no period and matches a calendar item
 * only on (event type, due date). Those rows were stored under the old due-date rule, which moved a weekend back
 * to Friday but left a public holiday alone; due dates now go through `previousBusinessDay` (holidays too), so an
 * item due on Thu 24 Dec 2026 may carry a legacy mark dated Fri 25 Dec. `legacyDueDates` lists every date such a
 * mark may be stored under for an item now due on `due`. Period-keyed marks (999c on) never use this.
 * Pure.
 */
import { addDaysIso, isSaBusinessDay } from '@/lib/saPublicHolidays';

const dayOfWeek = (iso: string): number => new Date(`${iso}T00:00:00Z`).getUTCDay();

/** The old rule: Saturday and Sunday back to Friday; a public holiday on a weekday stays. Never used for new dates. */
export function weekendOnlyPreviousDay(iso: string): string {
  const dow = dayOfWeek(iso);
  if (dow === 6) return addDaysIso(iso, -1);
  if (dow === 0) return addDaysIso(iso, -2);
  return iso;
}

/**
 * The due dates an old mark may carry for an item now due on `due` (a business day): `due` itself and, for each
 * non-business day that `previousBusinessDay` moved onto it (the nominal dates `due`+1 .. before the next business
 * day), the date the old rule gave.
 */
export function legacyDueDates(due: string): string[] {
  const out = new Set([due]);
  for (let nominal = addDaysIso(due, 1); !isSaBusinessDay(nominal); nominal = addDaysIso(nominal, 1)) {
    out.add(weekendOnlyPreviousDay(nominal));
  }
  return [...out].sort();
}
