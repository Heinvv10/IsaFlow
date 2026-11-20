/**
 * Which journals of a CANCELLED document the VAT201 hides for a period, as SQL fragments spliced into every reader of
 * the return: the box basis (vatBoxBasisQuery, fields 1, 1A, 4, 5 ...) and the nil-rated reader (vat201NilRatedSupplies,
 * fields 2 and 3 and the share field 1 gives back, and its drill vat201NilRatedDrill). ONE definition, because field 1
 * is the box basis LESS the nil-rated give-back: two rules for one journal declare the same rand twice, or not at all.
 *
 * THE PAIR RULE (K-032). A cancellation posts a reversing journal that no document row links to. The pair is only ever
 * hidden TOGETHER: when the original and its reversal both fall in the period, neither counts. resolveReversalDate pushes
 * the reversal into a later period when the original's is closed (fiscal close) or locked (VAT lock, for a journal that
 * moves a VAT figure), and then both legs are real: the original was filed in its own period and the reversal belongs
 * in the later one. So an original whose posted reversal falls outside this period is not hidden; a cancelled document
 * never reversed still is. Recursive, because reversing the reversal by hand would otherwise re-admit the cancelled
 * document's VAT; UNION dedupes, so a cycle terminates. Both arms walk POSTED journals only: a draft reversal has no GL
 * effect, so it neither frees its original nor carries the hiding on to its own reversal. (This is the one copy of the
 * explanation: the SQL text sent to the database carries none.)
 *
 * The base list names cancelled customer AND supplier documents. The nil-rated reader reads only revenue lines, which
 * customer documents post; a bill line may name a revenue account (billLineAccountGuard does not refuse one), and then
 * the shared list hides it exactly as the box basis already did. A cancelled invoice (either side) nulls its journal
 * link on cancel, so its journals are in no list and simply count, each in its own period.
 *
 * UNCODED revenue (no VAT code) counts in the nil-rated reader only where a zero-tax customer document stands behind it
 * (`untaxed_documents`: a live document's own journal, unchanged). A cancelled zero-tax document whose row STILL LINKS
 * its journal keeps its uncoded legs countable along the whole reversal chain (`untaxed_cancelled_chain`), so the pair
 * rule alone decides them, exactly as it decides coded legs: same period, the pair contributes nothing; across periods,
 * the original keeps the period it was filed in and the reversal carries the opposite into the later one. That is a
 * cancelled customer CREDIT NOTE (creditNoteCancelService keeps the link) and a legacy invoice row whose link survived
 * its cancel; customerInvoiceCancelService nulls the link today, so a cancelled invoice is in neither list (reports/
 * .claude.md OPEN).
 */
import { sql } from '@/lib/neon';

/**
 * A document in one of these states raises no VAT, but its journal may still be
 * posted — Brightsphere has exactly that, R3,750 of output VAT on a cancelled
 * customer invoice. Both spellings are in use across the AR, AP and credit-note
 * tables.
 */
export const CANCELLED_STATUSES: readonly string[] = ['cancelled', 'void', 'voided'];

/**
 * `cancelled_entries_base AS (...), cancelled_entries AS (...)`: the journals hidden for the period. Spliced after
 * another CTE (`, ${cancelledEntriesCteSql(...)}`) of a `WITH RECURSIVE`. A function, not a module constant: a fragment
 * built at import time would shift every positional `sql` mock in the unit suite.
 */
export function cancelledEntriesCteSql(companyId: string, periodStart: string, periodEnd: string) {
  return sql`cancelled_entries_base AS (
      SELECT ci.gl_journal_entry_id AS id FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID AND ci.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND ci.gl_journal_entry_id IS NOT NULL
      UNION
      SELECT si.gl_journal_entry_id FROM supplier_invoices si
        WHERE si.company_id = ${companyId}::UUID AND si.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND si.gl_journal_entry_id IS NOT NULL
      UNION
      SELECT cn.gl_journal_entry_id FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID AND cn.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND cn.gl_journal_entry_id IS NOT NULL
    )
    , cancelled_entries AS (
      SELECT b.id FROM cancelled_entries_base b
        WHERE NOT EXISTS (
          SELECT 1 FROM gl_journal_entries out_rev
            WHERE out_rev.company_id = ${companyId}::UUID
              AND out_rev.reversal_of_id = b.id
              AND out_rev.status = 'posted'
              AND (out_rev.entry_date < ${periodStart}::DATE
                   OR out_rev.entry_date > ${periodEnd}::DATE)
        )
      UNION
      SELECT rev.id FROM gl_journal_entries rev
        JOIN gl_journal_entries parent ON parent.id = rev.reversal_of_id
        JOIN cancelled_entries ce ON ce.id = parent.id
        WHERE rev.company_id = ${companyId}::UUID
          AND rev.status = 'posted'
          AND parent.company_id = ${companyId}::UUID
          AND parent.entry_date >= ${periodStart}::DATE
          AND parent.entry_date <= ${periodEnd}::DATE
    )`;
}

/**
 * `untaxed_documents AS (...), untaxed_cancelled_chain AS (...)`: the journals whose UNCODED revenue legs the nil-rated
 * reader counts (as zero-rated), before the pair rule hides any. Spliced after another CTE of a `WITH RECURSIVE`.
 *   - untaxed_documents: the journal a live (not cancelled) zero-tax customer invoice or customer note links.
 *   - untaxed_cancelled_chain: the journal a CANCELLED zero-tax one still links (a customer credit note; a legacy
 *     invoice row whose link survived, since the invoice cancel nulls it), and every posted reversal down its chain.
 *     Without it the pair rule could not keep such an original in its own, filed period, nor carry its reversal into
 *     the later one: the original belongs to no live document, the reversal to no document at all.
 */
export function untaxedJournalsCteSql(companyId: string) {
  return sql`untaxed_documents AS (
      SELECT ci.gl_journal_entry_id AS id FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID
          AND COALESCE(ci.tax_amount, 0) = 0
          AND ci.status <> ALL(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND ci.gl_journal_entry_id IS NOT NULL
      UNION
      SELECT cn.gl_journal_entry_id FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID
          AND cn.type = 'customer'
          AND COALESCE(cn.tax_amount, 0) = 0
          AND cn.status <> ALL(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND cn.gl_journal_entry_id IS NOT NULL
    ),
    untaxed_cancelled_chain AS (
      SELECT ci.gl_journal_entry_id AS id FROM customer_invoices ci
        WHERE ci.company_id = ${companyId}::UUID
          AND COALESCE(ci.tax_amount, 0) = 0
          AND ci.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND ci.gl_journal_entry_id IS NOT NULL
      UNION
      SELECT cn.gl_journal_entry_id FROM credit_notes cn
        WHERE cn.company_id = ${companyId}::UUID
          AND cn.type = 'customer'
          AND COALESCE(cn.tax_amount, 0) = 0
          AND cn.status = ANY(${CANCELLED_STATUSES as string[]}::TEXT[])
          AND cn.gl_journal_entry_id IS NOT NULL
      UNION
      SELECT rev.id FROM gl_journal_entries rev
        JOIN untaxed_cancelled_chain c ON c.id = rev.reversal_of_id
        WHERE rev.company_id = ${companyId}::UUID
          AND rev.status = 'posted'
    )`;
}

/** The uncoded-leg arm of the nil-rated predicate, over aliases `jl` (line) and `je` (its journal). */
export function uncodedLegCountsSql() {
  return sql`(jl.vat_type IS NULL AND (
        je.id IN (SELECT id FROM untaxed_documents)
        OR je.id IN (SELECT id FROM untaxed_cancelled_chain)
      ))`;
}
