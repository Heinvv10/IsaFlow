/**
 * A draft line's WIP time-entry link (`customer_invoice_items.time_entry_id`, PR S round eight). The draft edit
 * replaces every line on a PUT, so the edit page sends each line's `timeEntryId` back and the edit re-inserts it.
 *
 * What the link is: the line that bills a time entry (practiceWipService writes it with the invoice). The entry's own
 * billed state (`time_entries.status = 'billed'`, `invoice_id`, `billed_at`) is set then and is not touched by an
 * edit; the line link is not in the approval digest (migration 865). Only a link this invoice's lines already carry
 * may be sent back, each on one line: an edit can keep or drop a link, never make one (no billing a time entry, of
 * this company or another, by hand).
 *
 * A PUT whose lines leave a link out removed that WIP line, so its time entry is no longer billed by this invoice:
 * `releaseDroppedWipEntries` puts it back as `markEntriesBilled` found it (status 'approved', no invoice, no
 * billed_at), so it can be billed again, in the edit's transaction under its invoice lock. Only entries of this
 * company, billed by the WIP path (status 'billed') to this invoice: the timesheet path's 'invoiced' entries carry no
 * line link, and an entry billed elsewhere is not this invoice's to release. A grouped WIP invoice's lines carry no
 * link, so removing one releases nothing.
 */
import type { TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';

/** The refusal's code at the route: not a coding refusal (INVOICE_LINE_CODING_REFUSED). */
export const WIP_LINK_REFUSED = 'INVOICE_WIP_LINK_REFUSED';

export interface WipLinkCheck {
  /** Why the lines' links are refused, or null. */
  refusal: string | null;
  /** Time entries this invoice's lines link that the new lines do not: their lines were removed by the PUT. */
  dropped: string[];
}

/** Read under the caller's row lock, before any write; the links are read through the invoice's own company. */
export async function wipLinks(
  tx: TxSql, companyId: string, invoiceId: string, items: readonly { timeEntryId?: string | null }[],
): Promise<WipLinkCheck> {
  const asked = items.map((it) => it.timeEntryId?.toLowerCase() ?? null).filter((t): t is string => t !== null);
  if (new Set(asked).size !== asked.length) return { refusal: 'A time entry can be billed on one line only', dropped: [] };
  const rows = (await tx`
    SELECT cii.time_entry_id
      FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id
     WHERE cii.invoice_id = ${invoiceId}::UUID AND ci.company_id = ${companyId} AND cii.time_entry_id IS NOT NULL
  `) as { time_entry_id: string }[];
  const linked = new Set(rows.map((r) => String(r.time_entry_id).toLowerCase()));
  if (!asked.every((t) => linked.has(t))) return { refusal: 'A line can keep the time entry it bills, not take another', dropped: [] };
  const kept = new Set(asked);
  return { refusal: null, dropped: [...linked].filter((t) => !kept.has(t)) };
}

/** After the lines are replaced: the removed lines' time entries are unbilled again (see the header), and logged. */
export async function releaseDroppedWipEntries(
  tx: TxSql, companyId: string, invoiceId: string, check: WipLinkCheck | null,
): Promise<void> {
  if (!check || check.dropped.length === 0) return;
  const released = (await tx`
    UPDATE time_entries SET status = 'approved', invoice_id = NULL, billed_at = NULL, updated_at = NOW()
     WHERE company_id = ${companyId}::UUID AND id = ANY(${check.dropped}::UUID[])
       AND invoice_id = ${invoiceId}::UUID AND status = 'billed'
    RETURNING id
  `) as { id: string }[];
  const counts = { invoiceId, dropped: check.dropped.length, released: released.length };
  log.info('Draft edit removed WIP lines: their time entries are unbilled again', counts, 'customerInvoiceWipLinks');
}
