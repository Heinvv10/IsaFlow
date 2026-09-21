/**
 * Has this Sage ledger group already been posted, and is the journal that
 * matches it actually the same journal?
 *
 * Split out of sageImportService.ts for the 300-line cap. The logic is
 * unchanged; the comments below are the ones that were attached to it there,
 * because they record two earlier revisions that got this wrong.
 */

import { sql } from '@/lib/neon';
import { roundToCents } from '@/modules/accounting/utils/doubleEntry';
import type { DbRow } from '@/types/db';

export type LedgerRelinkDecision =
  /** No posted journal carries this reference and date — post a new one. */
  | { kind: 'none' }
  /** The existing journal IS this group — point the source rows at it. */
  | { kind: 'relink'; entryId: string }
  /** Same reference and date, different contents — refuse and report. */
  | { kind: 'mismatch'; entryId: string; journalLines: number };

/**
 * A multiset of (account, debit, credit), which is what distinguishes two
 * journals that agree on every total.
 */
function lineFingerprint(rows: DbRow[]): string {
  return rows
    .map(r => `${String(r.gl_account_id)}|${roundToCents(Number(r.debit || 0)).toFixed(2)}|${roundToCents(Number(r.credit || 0)).toFixed(2)}`)
    .sort()
    .join(';');
}

export async function decideLedgerRelink(
  companyId: string,
  entryRef: string,
  entryDate: string,
  activeLines: DbRow[],
): Promise<LedgerRelinkDecision> {
  // Keyed on (reference, entry_date) rather than reference alone, which is what
  // the old entry_number scheme got wrong: it collided for the same document
  // number on two different dates and failed a legitimate group.
  const existing = (await sql`
    SELECT id FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND reference = ${entryRef}
      AND entry_date = ${entryDate}::DATE
      AND posting_agent = 'import:sage'
      AND status = 'posted'
      AND reversed_at IS NULL
    LIMIT 1
  `) as DbRow[];

  if (!existing[0]) return { kind: 'none' };
  const entryId = String(existing[0].id);

  // Relink only if the existing journal actually represents THIS group. The key
  // is (reference, entry_date), which does not prove the contents match: if Sage
  // re-syncs a correcting line onto the same document and date and the operator
  // resets, the group now has more lines than the journal. Relinking blind would
  // mark the new line 'imported' against a journal that does not contain its
  // amount — the row claims to be in the GL and is not, with nothing to show it.
  // Compare the journal's LINES, not its totals. (An earlier revision compared
  // count + SUM(debit) + SUM(credit) and claimed the credit conjunct caught a
  // side flip. It was arithmetically incapable of it — see below — and its test
  // asserted `skipped + failed === 1`, which holds whether the guard refuses or
  // relinks.)
  //
  // Totals cannot detect a side flip. The caller's balance check guarantees
  // totalDebit === totalCredit for the group, and `status = 'posted'` guarantees
  // the same for the journal (enforce_balanced_entry is a BEFORE UPDATE trigger
  // on the draft→posted flip), so `existing.total_debit === totalDebit` implies
  // `existing.total_credit === totalCredit` — a second totals conjunct is
  // arithmetically incapable of adding information. An earlier revision added
  // exactly that redundant check and credited it with catching the flip; it
  // could not.
  //
  // A per-line multiset of (account, debit, credit) does catch it: Cr A 100 /
  // Dr B 100 and Dr A 100 / Cr B 100 have identical counts and identical totals
  // but different lines.
  const existingLines = (await sql`
    SELECT gl_account_id, debit, credit
    FROM gl_journal_lines
    WHERE journal_entry_id = ${entryId}::UUID
      AND company_id = ${companyId}::UUID
  `) as DbRow[];

  if (lineFingerprint(existingLines) !== lineFingerprint(activeLines)) {
    return { kind: 'mismatch', entryId, journalLines: existingLines.length };
  }
  return { kind: 'relink', entryId };
}
