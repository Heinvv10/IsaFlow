/**
 * Journals that belong to NO fiscal period.
 *
 * A NULL `fiscal_period_id` is an INVISIBLE journal: it posts, it balances, and
 * it appears in no period report — not the trial balance, not the VAT201, not
 * the AFS. Migration 501 names the cost of the last outbreak, Britech's
 * R267,109.70 salary understatement with 200+ more rows behind it.
 *
 * `createJournalEntry` resolves the period and `ensureFiscalPeriodForDate`
 * creates the year on demand when it cannot. Two paths INSERT into
 * `gl_journal_entries` directly and bypass both — the depreciation hook in
 * `glCrossModuleHooks.ts`, which is live and dates its entries `CURRENT_DATE`,
 * and the year-end close. Neither can invent a period that does not exist, and
 * every production company's periods stop at 2027-12-31 (the demo company has a
 * further 1,096-day hole between 2028-01-01 and 2030-12-31, reachable today by
 * any journal dated in it).
 *
 * ── WHY THIS CHECK IS COMPANY-SCOPED, NOT PERIOD-SCOPED ─────────────────────
 *
 * Every other close-readiness check narrows to the period being closed. This
 * one cannot, and that is the point: an orphan journal belongs to no period, so
 * no period-scoped query will ever return it. Asking at every close is right —
 * a close asserts that a period is complete, and an invisible journal is
 * exactly what that assertion cannot see.
 *
 * ── WHY `fail` AND NOT `warn` ───────────────────────────────────────────────
 *
 * A warning is something a close may step over. This is not: the books contain
 * postings that no period report can reach, so closing anything asserts a
 * completeness that does not hold. `close_fiscal_period` treats `fail` as a
 * blocker and refuses.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { ChecklistItem } from '../periodCloseReadinessService';

export async function orphanPeriodJournalsCheck(companyId: string): Promise<ChecklistItem> {
  // Posted only. A draft with no period is caught by `unposted_journals` and is
  // not yet in the books; a POSTED one is in the books and in no report.
  const rows = (await sql`
    SELECT COUNT(*)                                  AS orphan_count,
           MIN(je.entry_date)                        AS earliest,
           MAX(je.entry_date)                        AS latest,
           COALESCE(SUM(jl.debit), 0)::numeric       AS total
      FROM gl_journal_entries je
      LEFT JOIN gl_journal_lines jl
             ON jl.journal_entry_id = je.id
            AND jl.company_id       = ${companyId}::UUID
     WHERE je.company_id       = ${companyId}::UUID
       AND je.status           = 'posted'
       AND je.fiscal_period_id IS NULL
  `) as DbRow[];

  const row = rows[0];
  const count = Number(row?.orphan_count ?? 0);

  if (count === 0) {
    return {
      key: 'orphan_period_journals',
      label: 'Journals outside every period',
      status: 'pass',
      reason: 'Every posted journal belongs to a fiscal period.',
      fixHref: '/accounting/journal-entries',
    };
  }

  const earliest = row?.earliest ? fmtDate(row.earliest) : 'unknown';
  const latest = row?.latest ? fmtDate(row.latest) : 'unknown';
  const total = Number(row?.total ?? 0);

  return {
    key: 'orphan_period_journals',
    label: 'Journals outside every period',
    status: 'fail',
    reason:
      // Plain toFixed, not toLocaleString: this string is read by an agent as
      // well as a person, and en-ZA renders a non-breaking space thousands
      // separator and a comma decimal.
      `${count} posted journal entr${count === 1 ? 'y' : 'ies'} carrying R${total.toFixed(2)} `
      + `belong to no fiscal period (${earliest} to ${latest}). They are in the ledger and in no `
      + 'period report — not the trial balance, the VAT201 or the AFS. Create the fiscal years '
      + 'covering those dates, then re-date or re-post the entries.',
    fixHref: '/accounting/journal-entries',
  };
}
