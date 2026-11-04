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
 *
 * Releasing what a body leaves out is only safe when the body KNOWS the links. On an invoice whose lines link time
 * entries, every line must carry the `timeEntryId` key (null: deliberately not linked). A body lacking it on any line
 * comes from a client that does not know the field (a tab on an older bundle, an API or MCP client): its "missing"
 * links are lines still charged, and releasing them would make those entries billable twice. It is refused (409
 * INVOICE_WIP_CLIENT_STALE) before any write. An invoice with no links takes any body, as before.
 */
import type { TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';

/** The refusals' codes at the route: not a coding refusal (INVOICE_LINE_CODING_REFUSED). */
export const WIP_LINK_REFUSED = 'INVOICE_WIP_LINK_REFUSED'; // 400: a link the lines may not carry
export const WIP_CLIENT_STALE = 'INVOICE_WIP_CLIENT_STALE'; // 409: a body that does not carry the links at all
const CLIENT_STALE = 'This invoice has time-entry lines; reload the page and save again';

export interface WipLinkCheck {
  /** Why the lines' links are refused, and its code, or null. */
  refusal: { code: typeof WIP_LINK_REFUSED | typeof WIP_CLIENT_STALE; message: string } | null;
  /** Time entries this invoice's lines link that the new lines do not: their lines were removed by the PUT. */
  dropped: string[];
}

/**
 * Read under the caller's row lock, before any write; the links are read through the invoice's own company. Every
 * linked entry must be kept by a line or named in `release` (the entries whose lines the user removed, after the
 * question): a link the body just leaves out is refused, never released (round twelve).
 */
export async function wipLinks(
  tx: TxSql, companyId: string, invoiceId: string, items: readonly { timeEntryId?: string | null }[],
  release: readonly string[] = [],
): Promise<WipLinkCheck> {
  const asked = items.map((it) => it.timeEntryId?.toLowerCase() ?? null).filter((t): t is string => t !== null);
  const refuse = (message: string, code: typeof WIP_LINK_REFUSED | typeof WIP_CLIENT_STALE = WIP_LINK_REFUSED): WipLinkCheck =>
    ({ refusal: { code, message }, dropped: [] });
  if (new Set(asked).size !== asked.length) return refuse('A time entry can be billed on one line only');
  const rows = (await tx`
    SELECT cii.time_entry_id
      FROM customer_invoice_items cii JOIN customer_invoices ci ON ci.id = cii.invoice_id
     WHERE cii.invoice_id = ${invoiceId}::UUID AND ci.company_id = ${companyId} AND cii.time_entry_id IS NOT NULL
  `) as { time_entry_id: string }[];
  const linked = new Set(rows.map((r) => String(r.time_entry_id).toLowerCase()));
  if (linked.size > 0 && !items.every((it) => 'timeEntryId' in it)) return refuse(CLIENT_STALE, WIP_CLIENT_STALE);
  if (!asked.every((t) => linked.has(t))) return refuse('A line can keep the time entry it bills, not take another');
  const kept = new Set(asked);
  const named = [...new Set(release.map((t) => t.toLowerCase()))];
  if (!named.every((t) => linked.has(t) && !kept.has(t))) return refuse('Only a time entry this invoice bills, on no line now, can be released');
  if (![...linked].every((t) => kept.has(t) || named.includes(t))) {
    return refuse('A time-entry line came back without its link and without being released: reload the page and save again');
  }
  return { refusal: null, dropped: named };
}

/**
 * After the lines are replaced: the removed lines' time entries are unbilled again (see the header), each with an
 * audit_log row in the same statement (who, when, the invoice, the entry), and logged.
 */
export async function releaseDroppedWipEntries(
  tx: TxSql, companyId: string, invoiceId: string, check: WipLinkCheck | null, editedBy: string,
): Promise<void> {
  if (!check || check.dropped.length === 0) return;
  const changes = JSON.stringify({
    fields: [
      { field: 'status', old: 'billed', new: 'approved', label: 'Status' },
      { field: 'invoice_id', old: invoiceId, new: null, label: 'Invoice' },
    ],
    metadata: { invoiceId, reason: 'Its line was removed from the draft invoice' },
  });
  const released = (await tx`
    WITH released AS (
      UPDATE time_entries SET status = 'approved', invoice_id = NULL, billed_at = NULL, updated_at = NOW()
       WHERE company_id = ${companyId}::UUID AND id = ANY(${check.dropped}::UUID[])
         AND invoice_id = ${invoiceId}::UUID AND status = 'billed'
      RETURNING id
    )
    INSERT INTO audit_log (company_id, user_id, action, entity_type, entity_id, changes)
    SELECT ${companyId}::UUID, ${editedBy}, 'update', 'time_entry', id, ${changes}::JSONB FROM released
    RETURNING entity_id
  `) as { entity_id: string }[];
  const counts = { invoiceId, dropped: check.dropped.length, released: released.length };
  log.info('Draft edit removed WIP lines: their time entries are unbilled again', counts, 'customerInvoiceWipLinks');
}
