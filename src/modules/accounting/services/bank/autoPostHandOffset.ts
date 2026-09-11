/**
 * R-079 — has a person already offset an auto-posted journal by hand?
 *
 * A user who corrects an auto-posting with an ordinary journal instead of a
 * reversal leaves no `reversal_of_id` and no `reversed_at`, so the undo could
 * not see the correction and reversed the posting again: the correction was
 * applied twice. The undo now asks the ledger first, and refuses a row that
 * something outside its reversal chain already offsets.
 *
 * "Offsets" is decided by evidence, never by an equal-and-opposite amount
 * alone. Every candidate is a POSTED journal of the same company, posted
 * AFTER the posting, that is not a reversal of anything, is still on the
 * books, and moves at least one of the posting's accounts back. Among those,
 * a candidate offsets the posting when EITHER
 * - it is linked to the row: it names the bank transaction as its source
 *   record, or shares the posting's source document; OR
 * - it was made by a person (not an `auto_*` source), no other bank line owns
 *   it (as its allocation, or as a confirmed hand correction), and it lies
 *   wholly within the posting: every account it moves is one
 *   the posting moved, in the opposite direction, by no more than was posted.
 *
 * The second arm is what separates the measured hand offset (credit E1 60,
 * debit bank 60, against a posting of E1 60 + E2 40 / bank 100) from an
 * unrelated journal on the same account: a reclass touches an account the
 * posting did not; a refund is another bank line's allocation; a journal
 * dated before the posting cannot correct it.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { journalReversalState } from './journalReversalState';

/** The `audit_log` reason a confirmed hand correction is recorded under. */
export const HAND_CORRECTION_REASON = 'auto_post_corrected_by_hand';

export interface HandOffset {
  transactionId: string;
  journalEntryId: string;
  entryNumber: string;
}

interface OffsetCandidate {
  id: string;
  entryNumber: string;
  linked: boolean;
  byPerson: boolean;
  claimedElsewhere: boolean;
  withinPosting: boolean;
}

/** The journal an auto-posted row put on the books, or null if none is linked. */
export async function postingJournalOf(companyId: string, tx: DbRow): Promise<string | null> {
  if (tx.matched_journal_line_id) {
    const rows = (await sql`
      SELECT journal_entry_id FROM gl_journal_lines
      WHERE id = ${String(tx.matched_journal_line_id)}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    return rows[0]?.journal_entry_id ? String(rows[0].journal_entry_id) : null;
  }
  return tx.provisional_je_id ? String(tx.provisional_je_id) : null;
}

/**
 * Every journal that could be an offset of the posting — the base conditions
 * above — with the evidence for each arm. `onlyJournalId` narrows it to one
 * journal, for the override that names it.
 */
export async function offsetCandidates(
  companyId: string, postingJeId: string, txId: string, onlyJournalId: string | null = null,
): Promise<OffsetCandidate[]> {
  const rows = (await sql`
    WITH posting AS (
      SELECT id, COALESCE(posted_at, created_at) AS at, source_document_id
      FROM gl_journal_entries
      WHERE id = ${postingJeId}::UUID AND company_id = ${companyId}::UUID AND status = 'posted'
    ),
    effect AS (
      SELECT gl_account_id, SUM(debit - credit) AS net
      FROM gl_journal_lines
      WHERE journal_entry_id = ${postingJeId}::UUID AND company_id = ${companyId}::UUID
      GROUP BY gl_account_id
      HAVING SUM(debit - credit) <> 0
    ),
    candidate AS (
      SELECT o.id, o.entry_number, o.source, o.source_record_id, o.source_document_id,
             COALESCE(o.posted_at, o.created_at) AS at
      FROM gl_journal_entries o
      JOIN posting p ON COALESCE(o.posted_at, o.created_at) > p.at AND o.id <> p.id
      WHERE o.company_id = ${companyId}::UUID AND o.status = 'posted' AND o.reversal_of_id IS NULL
        AND (${onlyJournalId}::UUID IS NULL OR o.id = ${onlyJournalId}::UUID)
        AND EXISTS (
          SELECT 1 FROM gl_journal_lines l JOIN effect e ON e.gl_account_id = l.gl_account_id
          WHERE l.journal_entry_id = o.id AND l.company_id = ${companyId}::UUID
            AND SIGN(l.debit - l.credit) = -SIGN(e.net)
        )
    )
    SELECT c.id, c.entry_number,
      (c.source_record_id = ${txId}::UUID
        OR (p.source_document_id IS NOT NULL AND c.source_document_id = p.source_document_id)) AS linked,
      (COALESCE(c.source, 'manual') NOT LIKE 'auto_%') AS by_person,
      (EXISTS (
        SELECT 1 FROM bank_transactions bt
        WHERE bt.company_id = ${companyId}::UUID AND bt.id <> ${txId}::UUID
          AND (bt.provisional_je_id = c.id OR bt.matched_journal_line_id IN (
            SELECT id FROM gl_journal_lines WHERE journal_entry_id = c.id AND company_id = ${companyId}::UUID))
      ) OR EXISTS (
        SELECT 1 FROM audit_log a
        WHERE a.company_id = ${companyId}::UUID AND a.entity_type = 'bank_transaction'
          AND a.entity_id <> ${txId}::UUID
          AND a.changes -> 'metadata' ->> 'reason' = ${HAND_CORRECTION_REASON}
          AND a.changes -> 'metadata' ->> 'offsetJournalId' = c.id::TEXT
      )) AS claimed_elsewhere,
      NOT EXISTS (
        SELECT 1
        FROM (SELECT gl_account_id, SUM(debit - credit) AS net FROM gl_journal_lines
              WHERE journal_entry_id = c.id AND company_id = ${companyId}::UUID
              GROUP BY gl_account_id) ce
        LEFT JOIN effect e ON e.gl_account_id = ce.gl_account_id
        WHERE ce.net <> 0
          AND (e.gl_account_id IS NULL OR SIGN(ce.net) <> -SIGN(e.net) OR ABS(ce.net) > ABS(e.net))
      ) AS within_posting
    FROM candidate c CROSS JOIN posting p
    ORDER BY c.at, c.entry_number
  `) as DbRow[];

  const out: OffsetCandidate[] = [];
  for (const r of rows) {
    const id = String(r.id);
    // A journal someone has since reversed is off the books and offsets
    // nothing; one whose reversal was itself reversed is back on them.
    if ((await journalReversalState(companyId, id)) === 'live') continue;
    out.push({
      id,
      entryNumber: String(r.entry_number ?? id),
      linked: r.linked === true,
      byPerson: r.by_person === true,
      claimedElsewhere: r.claimed_elsewhere === true,
      withinPosting: r.within_posting === true,
    });
  }
  return out;
}

/** The first journal that already offsets the posting, or null. */
export async function findHandOffset(
  companyId: string, postingJeId: string, txId: string,
): Promise<HandOffset | null> {
  const hit = (await offsetCandidates(companyId, postingJeId, txId)).find(
    (c) => c.linked || (c.byPerson && !c.claimedElsewhere && c.withinPosting),
  );
  return hit ? { transactionId: txId, journalEntryId: hit.id, entryNumber: hit.entryNumber } : null;
}
