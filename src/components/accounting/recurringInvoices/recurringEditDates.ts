/**
 * Date handling for the recurring-invoice edit page. Mirrors the server (assertEditDatesConsistent):
 * end < next is only judged when a date actually changed, and endDate is only sent when it changed,
 * so a save never overwrites an end date someone else changed since the page was opened.
 */

import type { LineItem } from './LineItemsSection';

export interface EditDates { nextRunDate: string; endDate: string }

// Judged against the loaded values; the server compares against stored ones and is authoritative, so the
// client can refuse a save the server would accept if someone else changed a date meanwhile.
export function endBeforeNextRefused(form: EditDates, loaded: EditDates): boolean {
  const changed = form.endDate !== loaded.endDate || form.nextRunDate !== loaded.nextRunDate;
  return changed && !!form.endDate && form.endDate < form.nextRunDate;
}

/**
 * Only changed dates are sent (cleared endDate -> null). An absent key means "keep" on the server, so a save
 * never writes back a date a scheduled run or another user moved since the page loaded.
 */
export function datePayload(form: EditDates, loaded: EditDates): { nextRunDate?: string; endDate?: string | null } {
  return {
    ...(form.nextRunDate !== loaded.nextRunDate ? { nextRunDate: form.nextRunDate } : {}),
    ...(form.endDate !== loaded.endDate ? { endDate: form.endDate || null } : {}),
  };
}

interface RawLineItem {
  description?: string;
  quantity?: number;
  unitPrice?: number;
  unit_price?: number;
  glAccountId?: string;
  gl_account_id?: string;
}

/** The template's lines, whichever casing the API row carries. */
export function rawLineItems(found: Record<string, unknown>): RawLineItem[] {
  if (Array.isArray(found.lineItems)) return found.lineItems as RawLineItem[];
  return Array.isArray(found.line_items) ? (found.line_items as RawLineItem[]) : [];
}

/** The template's lines as editable rows. */
export function editLines(found: Record<string, unknown>): LineItem[] {
  return rawLineItems(found).map((l, i) => ({
    key: String(i),
    description: String(l.description ?? ''),
    quantity: Number(l.quantity ?? 1),
    unitPrice: Number(l.unitPrice ?? l.unit_price ?? 0),
    glAccountId: String(l.glAccountId ?? l.gl_account_id ?? ''),
  }));
}
