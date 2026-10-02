/**
 * Pre-filing exception: ISSUED invoices and APPROVED bills that carry VAT but
 * were never posted to the GL (no `gl_journal_entry_id`).
 *
 * WHY IT BLOCKS (Hein, 2026-09-25). The control recon ties the FILED ledger
 * VAT201 to the VAT control accounts. A document whose VAT never reached the
 * GL is in neither, so the recon ties at R0 and the return files without it —
 * on dev, R1.68m of output VAT across 180 invoices in one period. The old
 * invoice-based recon caught that as a variance; with the recon on the ledger
 * this list is what keeps catching it, and it is counted in `totalExceptions`.
 * It also feeds the recon's unposted footnote, so the two can never disagree.
 *
 * Population, as the VAT201 readers take it:
 *   - customer invoices: issued — approved / sent / partially_paid / paid /
 *     overdue. Draft, pending_approval and cancelled raise no VAT
 *     (shared/documentPopulation's exclusions).
 *   - supplier bills: `status IN ('approved','partially_paid','paid')`, the
 *     allow-list `generateVAT201` uses ("count approved bills only") —
 *     draft, pending_approval, disputed and cancelled claim nothing. VAT is
 *     Σ supplier_invoice_items.tax_amount when the bill has items (the field
 *     10 source), else the header `tax_amount`.
 *   - dated by `invoice_date` in the period (a bill with no journal cannot
 *     have a late-claim companion, so the companion dating never applies);
 *   - soft-deleted documents (`deleted_at`) are left out: a deleted document
 *     raises no VAT, and listing it would block a period nobody can clear.
 *   - a document marked "VAT declared outside IsaFlow" (migration 705,
 *     vatDeclaredElsewhereService) is left out here and appears instead in
 *     `findVatDeclaredElsewhere` (vatDeclaredElsewhereQuery.ts, re-exported
 *     below) — NON-blocking, but still visible.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { journalReversedAsAtFragment } from '../shared/softDeleteLedgerPresence';

// Exported so vatDeclaredElsewhereQuery.ts (split out, 2026-09-27, file-size
// limit) shares the exact same population — test either against
// shared/documentPopulation's own lists rather than assuming the two never
// drift.
export const ISSUED_CUSTOMER_INVOICE_STATUSES: readonly string[] =
  ['approved', 'sent', 'partially_paid', 'paid', 'overdue'];
export const APPROVED_BILL_STATUSES: readonly string[] = ['approved', 'partially_paid', 'paid'];

/**
 * A document counts as unposted invoice VAT not only when it has NO journal
 * (`reason: 'no_journal'`), but also when its linked journal is not posted
 * (`'journal_not_posted'`) or is REVERSED OUT as at the period end — an odd
 * number of posted reversals in its chain dated on or before it, never just
 * "has one" (D7: a delete undone in-period, O <- R <- R2, stands) —
 * (`'journal_reversed'`, B3). A reversal nets the original's VAT
 * out of the filed ledger (vatEntryMembership) while `status = 'sent'` etc.
 * on the invoice itself is untouched — reverseJournalEntry carries no
 * document guard — so without this an issued invoice's output VAT vanishes
 * from both the ledger AND this exception, filing R0 with zero exceptions. A
 * reversal dated in a LATER period is left alone: the invoice's VAT is still
 * filed, correctly, in the reversed journal's own period.
 *
 * CUSTOMER invoices only (Hein, 2026-09-27): a journal that IS posted and
 * carries no such early reversal, but whose OWN `entry_date` is AFTER the
 * period end, also blocks — `'journal_dated_after_period'`. Time of supply is
 * the invoice date, and the ledger VAT201 reads by journal date, so that
 * output VAT is absent from the period the invoice belongs to with no
 * exception raised, under-declaring it. A journal dated BEFORE the period
 * start is out of scope — the earlier period is a different concern. SUPPLIER
 * bills are deliberately NOT given this check: a bill's journal dated after
 * its own invoice period is a legitimate late input-VAT claim (s16(3)), the
 * same reasoning `generateVAT201`'s late-claim companion dating already
 * applies — so this arm is customer-only, unlike the two above it.
 *
 * Tie-break (deterministic, never both): a journal that is BOTH dated after
 * the period end AND reversed by a POSTED reversal dated on or before the
 * period end reads as `'journal_reversed'` — that check is evaluated first,
 * exactly as it already runs ahead of this new one in the CASE below. In
 * practice `reverseJournalEntry` refuses to date a reversal before the entry
 * it reverses, so an original dated after the period end can only ever gain a
 * reversal dated after it too, and this combination should not occur via the
 * app — the ordering still matters for whatever other data reaches this
 * query (a historical import, a direct fix).
 */
export async function findUnpostedInvoiceVat(
  companyId: string, periodStart: string, periodEnd: string,
): Promise<DbRow[]> {
  return sql`
    SELECT * FROM (
      SELECT 'customer' AS kind, ci.id AS invoice_id, ci.invoice_number, ci.invoice_date,
        COALESCE(c.name, cl.name, 'Unknown') AS counterparty_name,
        COALESCE(ci.tax_amount, 0) AS unposted_vat,
        CASE
          WHEN ci.gl_journal_entry_id IS NULL THEN 'no_journal'
          WHEN je.status IS DISTINCT FROM 'posted' THEN 'journal_not_posted'
          WHEN ${journalReversedAsAtFragment('ci', periodEnd, companyId)} THEN 'journal_reversed'
          ELSE 'journal_dated_after_period'
        END AS reason
      FROM customer_invoices ci
      LEFT JOIN customers c ON c.id = ci.customer_id AND c.company_id = ${companyId}::UUID
      LEFT JOIN clients cl ON cl.id = ci.client_id
      LEFT JOIN gl_journal_entries je
        ON je.id = ci.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
      WHERE ci.company_id = ${companyId}::UUID
        AND ci.deleted_at IS NULL
        -- Breaker fix (2026-09-26): a mark is ignored for a document whose
        -- journal was posted then reversed — its VAT DID reach the GL and
        -- then left it, so it must still block (as 'journal_reversed'
        -- below), never sit unseen in the declared-elsewhere list instead.
        -- Extended 2026-09-27: also ignored when the journal is posted,
        -- unreversed, but dated AFTER the period end — its VAT reached the
        -- GL, just under the wrong period, so a mark placed before that
        -- journal ever posted must not hide it as 'journal_dated_after_period'
        -- below. (isEligibleForVatDeclaredElsewhereMark already refuses to
        -- mark a document once its journal IS posted, so this only matters
        -- for a mark made earlier, on a document whose journal posts later.)
        -- HIGH fix (review, 2026-09-27, on a6cb6ea71): this OR carried no
        -- je.status = 'posted' guard — entry_date is NOT NULL even on a
        -- DRAFT journal, so a mark on a document whose journal never even
        -- posted (dated after the period end but still draft) was overridden
        -- and the document wrongly appeared on the BLOCKING list as
        -- journal_not_posted instead of staying on the non-blocking
        -- declared-elsewhere list. The guard now matches the reason CASE
        -- above, which only reaches journal_dated_after_period once the
        -- journal is already known to be posted and unreversed.
        AND (
          ci.vat_declared_elsewhere_at IS NULL
          OR ${journalReversedAsAtFragment('ci', periodEnd, companyId)}
          OR (je.status = 'posted' AND je.entry_date > ${periodEnd}::DATE)
        )
        AND ci.status = ANY(${ISSUED_CUSTOMER_INVOICE_STATUSES as string[]}::TEXT[])
        AND ci.invoice_date >= ${periodStart}::DATE AND ci.invoice_date <= ${periodEnd}::DATE
        AND (
          ci.gl_journal_entry_id IS NULL
          OR je.status IS DISTINCT FROM 'posted'
          OR ${journalReversedAsAtFragment('ci', periodEnd, companyId)}
          -- CUSTOMER only (see the doc-comment above): a posted, unreversed
          -- journal dated after time-of-supply's own period under-declares
          -- output VAT with no exception otherwise.
          OR je.entry_date > ${periodEnd}::DATE
        )
      UNION ALL
      SELECT 'supplier', si.id, si.invoice_number, si.invoice_date,
        COALESCE(s.name, 'Unknown'),
        -- supplier_invoice_items carries no company_id of its own (same as
        -- vat201Service.ts:138) — scoped explicitly via si.company_id here
        -- too, not merely by si.id already being a company-scoped row.
        COALESCE((SELECT SUM(sii.tax_amount) FROM supplier_invoice_items sii
                  WHERE sii.supplier_invoice_id = si.id AND si.company_id = ${companyId}::UUID), si.tax_amount, 0),
        CASE
          WHEN si.gl_journal_entry_id IS NULL THEN 'no_journal'
          WHEN je.status IS DISTINCT FROM 'posted' THEN 'journal_not_posted'
          ELSE 'journal_reversed'
        END
      FROM supplier_invoices si
      LEFT JOIN suppliers s ON s.id = si.supplier_id AND s.company_id = ${companyId}::UUID
      LEFT JOIN gl_journal_entries je
        ON je.id = si.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
      WHERE si.company_id = ${companyId}::UUID
        AND si.deleted_at IS NULL
        -- Same reasoning as the customer branch above.
        AND (
          si.vat_declared_elsewhere_at IS NULL
          OR ${journalReversedAsAtFragment('si', periodEnd, companyId)}
        )
        AND si.status = ANY(${APPROVED_BILL_STATUSES as string[]}::TEXT[])
        AND si.invoice_date >= ${periodStart}::DATE AND si.invoice_date <= ${periodEnd}::DATE
        AND (
          si.gl_journal_entry_id IS NULL
          OR je.status IS DISTINCT FROM 'posted'
          OR ${journalReversedAsAtFragment('si', periodEnd, companyId)}
        )
    ) docs
    WHERE unposted_vat <> 0
    ORDER BY invoice_date, invoice_number
  ` as Promise<DbRow[]>;
}

export type VatDocKind = 'customer' | 'supplier';

/**
 * Whether a document is currently eligible to be marked "VAT declared
 * outside IsaFlow" (VAT-gaps breaker fix, 2026-09-26): true only when its
 * VAT has NEVER reached the GL — no journal, or a journal that was never
 * posted. A document whose `gl_journal_entry_id` points at a journal that IS
 * or WAS posted (including one posted then reversed) is NOT eligible, even
 * though a reversed one still counts as blocking in `findUnpostedInvoiceVat`
 * — that population is deliberately wider than what may be marked. Reuses
 * the same status allow-lists and GL-state predicate as
 * `findUnpostedInvoiceVat`/`findVatDeclaredElsewhere` — one source of truth
 * for "which documents carry filable VAT" — but ignores the period (marking
 * is not period-scoped) and `vat_declared_elsewhere_at` (checked before any
 * mark exists). Scoped by `company_id`; a foreign or absent id returns
 * `false` with no existence oracle.
 */
export async function isEligibleForVatDeclaredElsewhereMark(
  companyId: string, kind: VatDocKind, invoiceId: string,
): Promise<boolean> {
  const rows = kind === 'customer'
    ? await sql`
        SELECT 1 FROM customer_invoices ci
        LEFT JOIN gl_journal_entries je
          ON je.id = ci.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
        WHERE ci.id = ${invoiceId}::UUID AND ci.company_id = ${companyId}::UUID
          AND ci.deleted_at IS NULL
          AND ci.status = ANY(${ISSUED_CUSTOMER_INVOICE_STATUSES as string[]}::TEXT[])
          AND COALESCE(ci.tax_amount, 0) <> 0
          AND (ci.gl_journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted')
          AND NOT EXISTS (
            SELECT 1 FROM gl_journal_entries rev
            WHERE rev.reversal_of_id = ci.gl_journal_entry_id AND rev.company_id = ${companyId}::UUID AND rev.status = 'posted'
          )
      `
    : await sql`
        SELECT 1 FROM supplier_invoices si
        LEFT JOIN gl_journal_entries je
          ON je.id = si.gl_journal_entry_id AND je.company_id = ${companyId}::UUID
        WHERE si.id = ${invoiceId}::UUID AND si.company_id = ${companyId}::UUID
          AND si.deleted_at IS NULL
          AND si.status = ANY(${APPROVED_BILL_STATUSES as string[]}::TEXT[])
          AND COALESCE((SELECT SUM(sii.tax_amount) FROM supplier_invoice_items sii
                        WHERE sii.supplier_invoice_id = si.id AND si.company_id = ${companyId}::UUID), si.tax_amount, 0) <> 0
          AND (si.gl_journal_entry_id IS NULL OR je.status IS DISTINCT FROM 'posted')
          AND NOT EXISTS (
            SELECT 1 FROM gl_journal_entries rev
            WHERE rev.reversal_of_id = si.gl_journal_entry_id AND rev.company_id = ${companyId}::UUID AND rev.status = 'posted'
          )
      `;
  return (rows as DbRow[]).length > 0;
}

// `findVatDeclaredElsewhere` split out to vatDeclaredElsewhereQuery.ts
// (2026-09-27, file-size limit) — re-exported below so no caller's import
// path changes.
export { findVatDeclaredElsewhere } from './vatDeclaredElsewhereQuery';
