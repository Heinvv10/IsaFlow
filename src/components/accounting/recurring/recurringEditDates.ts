/**
 * Date handling for the recurring-invoice edit page. Mirrors the server (assertEditDatesConsistent):
 * end < next is only judged when a date actually changed, and endDate is only sent when it changed,
 * so a save never overwrites an end date someone else changed since the page was opened.
 */

export interface EditDates { nextRunDate: string; endDate: string }

export function endBeforeNextRefused(form: EditDates, loaded: EditDates): boolean {
  const changed = form.endDate !== loaded.endDate || form.nextRunDate !== loaded.nextRunDate;
  return changed && !!form.endDate && form.endDate < form.nextRunDate;
}

/** nextRunDate always; endDate only when changed (cleared -> null). An absent key means "keep" on the server. */
export function datePayload(form: EditDates, loaded: EditDates): { nextRunDate: string; endDate?: string | null } {
  return form.endDate === loaded.endDate
    ? { nextRunDate: form.nextRunDate }
    : { nextRunDate: form.nextRunDate, endDate: form.endDate || null };
}
