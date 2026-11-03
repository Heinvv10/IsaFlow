/**
 * A draft line's WIP time-entry link (`customer_invoice_items.time_entry_id`, PR S round eight). The draft edit
 * replaces every line on a PUT, so the edit page sends each line's `timeEntryId` back and the edit re-inserts it.
 *
 * What the link is: the line that bills a time entry (practiceWipService writes it with the invoice). The entry's own
 * billed state (`time_entries.status = 'billed'`, `invoice_id`, `billed_at`) is set then. Dropping its line returns
 * the entry to approved WIP so it can be billed again. The line link is not in the approval digest (migration 865).
 * Only a link this invoice's lines already carry
 * may be sent back, each on one line: an edit can keep or drop a link, never make one (no billing a time entry, of
 * this company or another, by hand).
 */
import type { TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';

/** The refusal's code at the route: not a coding refusal (INVOICE_LINE_CODING_REFUSED). */
export const WIP_LINK_REFUSED = 'INVOICE_WIP_LINK_REFUSED';

export interface WipLinkCheck {
  /** Why the lines' links are refused, or null. */
  refusal: string | null;
  /** Links this invoice's lines carry that the new lines do not: dropped by the PUT. */
  dropped: number;
  /** The dropped entries to return to approved WIP after the replacement lines are written. */
  droppedIds: string[];
}

/** Read under the caller's row lock, before any write; the links are read through the invoice's own company. */
export async function wipLinks(
  tx: TxSql, companyId: string, invoiceId: string, items: readonly { timeEntryId?: string | null }[],
): Promise<WipLinkCheck> {
  const asked = items.map((it) => it.timeEntryId?.toLowerCase() ?? null).filter((t): t is string => t !== null);
  if (new Set(asked).size !== asked.length) return { refusal: 'A time entry can be billed on one line only', dropped: 0, droppedIds: [] };
  const rows = (await tx`
    SELECT cii.time_entry_id
      FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id
     WHERE cii.invoice_id = ${invoiceId}::UUID AND ci.company_id = ${companyId} AND cii.time_entry_id IS NOT NULL
  `) as { time_entry_id: string }[];
  const linked = new Set(rows.map((r) => String(r.time_entry_id).toLowerCase()));
  if (!asked.every((t) => linked.has(t))) return { refusal: 'A line can keep the time entry it bills, not take another', dropped: 0, droppedIds: [] };
  const askedSet = new Set(asked);
  const droppedIds = [...linked].filter((id) => !askedSet.has(id));
  return { refusal: null, dropped: droppedIds.length, droppedIds };
}

/** After the lines are replaced, make their former entries billable again in the same transaction. */
export async function releaseDroppedWipLinks(
  tx: TxSql, companyId: string, invoiceId: string, check: WipLinkCheck | null,
): Promise<void> {
  if (!check || check.dropped <= 0) return;
  await tx`
    UPDATE time_entries
       SET status = 'approved', invoice_id = NULL, billed_at = NULL, updated_at = NOW()
     WHERE company_id = ${companyId}::UUID AND invoice_id = ${invoiceId}::UUID
       AND id = ANY(${check.droppedIds}::UUID[]) AND status = 'billed'
  `;
  log.warn('Draft edit dropped WIP time-entry links', { invoiceId, dropped: check.dropped }, 'customerInvoiceWipLinks');
}
