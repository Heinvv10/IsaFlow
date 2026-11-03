/**
 * A draft line's WIP time-entry link (`customer_invoice_items.time_entry_id`, PR S round eight). The draft edit
 * replaces every line on a PUT, so the edit page sends each line's `timeEntryId` back and the edit re-inserts it.
 *
 * What the link is: the line that bills a time entry (practiceWipService writes it with the invoice). The entry's own
 * billed state (`time_entries.status = 'billed'`, `invoice_id`, `billed_at`) is set then and is not touched by an
 * edit; the line link is not in the approval digest (migration 865). Only a link this invoice's lines already carry
 * may be sent back, each on one line: an edit can keep or drop a link, never make one (no billing a time entry, of
 * this company or another, by hand).
 */
import type { TxSql } from '@/lib/neon';

/** Why the lines' links are refused, or null. Read under the caller's row lock, before any write. */
export async function wipLinkRefusal(tx: TxSql, invoiceId: string, items: readonly { timeEntryId?: string | null }[]): Promise<string | null> {
  const asked = items.map((it) => it.timeEntryId?.toLowerCase() ?? null).filter((t): t is string => t !== null);
  if (asked.length === 0) return null;
  if (new Set(asked).size !== asked.length) return 'A time entry can be billed on one line only';
  const rows = (await tx`
    SELECT time_entry_id FROM customer_invoice_items WHERE invoice_id = ${invoiceId}::UUID AND time_entry_id IS NOT NULL
  `) as { time_entry_id: string }[];
  const linked = new Set(rows.map((r) => String(r.time_entry_id).toLowerCase()));
  return asked.every((t) => linked.has(t)) ? null : 'A line can keep the time entry it bills, not take another';
}
