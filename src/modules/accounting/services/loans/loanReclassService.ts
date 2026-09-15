import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { JournalEntryCreateInput, JournalLineInput } from '@/modules/accounting/types/gl.types';
import type { LoanGlAccounts } from './loanGlPostingService';

type Row = DbRow;

export interface SnapshotRow {
  closing: number;
  stLiability: number;
  /** What the previous close actually reclassified for this loan. */
  priorStLiability?: number;
}

/**
 * The current-portion reclass restates a BALANCE, not a transaction: after the
 * close the current-portion account must hold this period's `stLiability`, so
 * only the movement since the previous close belongs in the journal. Posting
 * the full amount every month compounds the current / non-current split.
 */
export function buildReclassificationInput(
  snapshot: SnapshotRow,
  accounts: LoanGlAccounts,
  postingDate: string,
  narrative: string,
): JournalEntryCreateInput {
  const lines: JournalLineInput[] = [];
  const movement = snapshot.stLiability - (snapshot.priorStLiability ?? 0);
  if (movement > 0) {
    lines.push({ glAccountId: accounts.loanLiability, debit: movement, credit: 0, description: narrative });
    lines.push({ glAccountId: accounts.currentPortion, debit: 0, credit: movement, description: narrative });
  } else if (movement < 0) {
    lines.push({ glAccountId: accounts.currentPortion, debit: -movement, credit: 0, description: narrative });
    lines.push({ glAccountId: accounts.loanLiability, debit: 0, credit: -movement, description: narrative });
  }
  return { entryDate: postingDate, description: narrative, source: 'manual', lines };
}

/**
 * What the most recent close before `yyyymm` actually reclassified for each
 * loan, keyed by loan id.
 *
 * Read from `loan_reclass_postings`, which is written only when a reclass
 * posts. Two earlier sources were wrong: `loan_period_locks` records that a
 * month closed, not that THIS loan was reclassified in it (the close skips
 * loans with missing GL accounts, no schedule row, or a zero movement, and
 * locks the month anyway), and the latest schedule run restates the earlier
 * month's `st_liability` whenever the loan is repriced between two closes.
 */
export async function fetchPriorReclass(
  companyId: string,
  yyyymm: string,
): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT DISTINCT ON (loan_id) loan_id, st_liability
    FROM loan_reclass_postings
    WHERE company_id = ${companyId} AND yyyymm < ${yyyymm}
    ORDER BY loan_id, yyyymm DESC
  `) as Row[];
  return new Map(rows.map((r) => [String(r.loan_id), parseFloat(String(r.st_liability ?? '0'))]));
}

/**
 * Record the balance a close just reclassified this loan's current portion to.
 *
 * `source = 'app'` marks the row as written by the running application, which
 * is what keeps migration 659's rebuild from ever deleting it (round-3 M1/M5).
 */
export async function recordReclass(
  companyId: string,
  loanId: string,
  yyyymm: string,
  stLiability: number,
  journalEntryId: string,
): Promise<void> {
  await sql`
    INSERT INTO loan_reclass_postings
      (company_id, loan_id, yyyymm, st_liability, journal_entry_id, source)
    VALUES (${companyId}, ${loanId}, ${yyyymm}, ${stLiability}, ${journalEntryId}, 'app')
    ON CONFLICT (company_id, loan_id, yyyymm)
    DO UPDATE SET st_liability = EXCLUDED.st_liability,
                  journal_entry_id = EXCLUDED.journal_entry_id,
                  source = 'app'
  `;
}
