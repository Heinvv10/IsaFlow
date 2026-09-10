/**
 * Which time entries were unbilled WIP on a date — the one population
 * `getWipAging` and `getRevenuePipeline.totalApproved` both report (R-059).
 *
 * WIP is an approved, billable entry that has not left. It enters on approval
 * and leaves by one of three exits, each dated where the schema allows:
 *
 *   billed        markEntriesBilled            -> billed_at
 *   invoiced      time-entries-invoice.ts,     -> the linked invoice's own date,
 *                 markAsInvoiced                  COALESCE(invoice_date,
 *                                                 created_at::date) — the date
 *                                                 the AR ageing admits it from,
 *                                                 so the entry is never WIP and
 *                                                 AR on the same day, nor neither
 *   written off   writeOffEntries              -> written_off_at
 *
 * Rewinding an exit puts the entry back for dates before it. An exit that
 * cannot be dated — `invoiced` whose invoice_id does not resolve to an invoice
 * of this company (markAsInvoiced takes the id from the request body and the
 * column has no FK) — is treated as having always happened, as agingRewind
 * treats undated settlement: past WIP may be understated, never inflated by
 * work that has since left.
 *
 * UNDATED APPROVAL. `timeTrackingService.approveEntries` did not set
 * approved_at before this change, and its rows are still in the table, so the
 * entry date cannot come from approved_at alone. An entry that is `approved`
 * now with no approved_at is in force from its work date — it cannot have been
 * approved before the work — capped at today, so TODAY's figure keeps every
 * such row exactly as it did (an entry_date in the future would otherwise drop
 * out). An entry that has since LEFT with no approved_at is not counted at any
 * past date: time-entries-invoice.ts invoices drafts and submitted entries
 * too, so without an approval date there is no evidence it was ever WIP.
 *
 * TODAY IS UNCHANGED BY CONSTRUCTION. An undated approval counts from no
 * later than today, and an entry that has left counts only at a date strictly
 * before today, so at `asOfDate = today` the population is the old
 * `status = 'approved' AND billed_at IS NULL` exactly. Without the second
 * bound an invoice dated in the FUTURE would pull its entries back into
 * today's WIP. It is written as its own conjunct rather than as
 * LEAST(exit, today) because LEAST ignores NULL: an undated exit would become
 * "today" and count at every past date, the opposite of the rule above.
 *
 * Dates are `::DATE` in the UTC session, as the bucket arithmetic in
 * getWipAging has always been.
 */

import { sql } from '@/lib/neon';

/** A predicate over `time_entries te`: in WIP at the end of `asOfDate`. */
export function wipInForceAsOf(companyId: string, asOfDate: string, todayStr: string) {
  return sql`(
    (te.status = 'approved'
      AND COALESCE(te.approved_at::DATE, LEAST(te.entry_date, ${todayStr}::DATE)) <= ${asOfDate}::DATE
      AND (te.billed_at IS NULL OR te.billed_at::DATE > ${asOfDate}::DATE))
    OR (te.status IN ('billed', 'invoiced', 'not_billable')
      AND te.approved_at::DATE <= ${asOfDate}::DATE
      AND ${todayStr}::DATE > ${asOfDate}::DATE
      AND CASE te.status
            WHEN 'billed' THEN te.billed_at::DATE
            WHEN 'invoiced' THEN (
              SELECT COALESCE(ci.invoice_date, ci.created_at::DATE)
              FROM customer_invoices ci
              WHERE ci.id = te.invoice_id AND ci.company_id = ${companyId}::UUID)
            WHEN 'not_billable' THEN te.written_off_at::DATE
          END > ${asOfDate}::DATE)
  )`;
}
