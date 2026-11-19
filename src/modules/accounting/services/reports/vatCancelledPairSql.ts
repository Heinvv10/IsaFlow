/**
 * Which journals of a CANCELLED document the VAT201 hides for a period, as an SQL fragment: the box basis
 * (vatBoxBasisQuery) splices it.
 *
 * THE PAIR RULE (K-032). A cancellation posts a reversing journal that no document row links to. The pair is only ever
 * hidden TOGETHER: when the original and its reversal both fall in the period, neither counts. resolveReversalDate pushes
 * the reversal into a later period when the original's is closed (fiscal close) or locked (VAT lock, for a journal that
 * moves a VAT figure), and then both legs are real: the original was filed in its own period and the reversal belongs
 * in the later one. So an original whose posted reversal falls outside this period is not hidden; a cancelled document
 * never reversed still is. Recursive: a hand reversal of the reversal is hidden with them.
 *
 * The box basis reads it today; the nil-rated reader is to share it, so the two cannot drift.
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
    -- A cancellation posts a reversing journal that no document row links to,
    -- so the original alone was suppressed and the reversal landed in the boxes.
    -- The pair is only ever hidden TOGETHER. resolveReversalDate pushes the
    -- reversal into a later period when the original's period is closed, and
    -- then both legs are real: the original was filed in its own period and the
    -- credit belongs in the later one. So an original whose posted reversal
    -- falls outside this period is not suppressed either, while a cancelled
    -- document that was never reversed still is.
    -- Recursive because reversing the reversal by hand would otherwise re-admit
    -- the cancelled document's VAT; UNION dedupes, so a cycle terminates. Both
    -- arms walk POSTED journals only: a draft reversal has no GL effect, so it
    -- neither frees its original nor carries suppression on to its own reversal.
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
