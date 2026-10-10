/**
 * R-079 — has a person already corrected an auto-posted journal by hand?
 *
 * A user who corrects an auto-posting with an ordinary journal instead of a
 * reversal leaves no `reversal_of_id` and no `reversed_at`, so the undo could
 * not see the correction and reversed the posting again: the correction was
 * applied twice. The undo now asks the ledger first, and refuses a row that a
 * later journal may already correct. The user then decides, and the decision
 * is recorded (autoPostHandCorrection.ts): mark it as the correction, or
 * declare it unrelated and undo anyway.
 *
 * A journal BLOCKS the undo when it is POSTED, in the same company, posted
 * AFTER the posting, not a reversal of anything, still on the books, not
 * declared unrelated to this line, and EITHER
 * - it is linked to the row (it names the bank line as its source record, or
 *   shares the posting's source document); OR
 * - a person made it, no other bank line owns it (as its allocation or as its
 *   confirmed correction), and it moves one of the posting's NON-bank
 *   accounts back.
 *
 * The second arm fails closed on purpose. It catches the measured offset
 * (credit E1, debit bank) AND the reclass (credit E1, debit E3) — probably
 * the most common hand correction, and indistinguishable in the ledger from an
 * unrelated journal on E1. The user tells them apart, not a heuristic.
 * A journal that moves only the bank back does not block: every posting
 * touches the bank, and a later receipt says nothing about this line.
 */

import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { projectUndo, type UndoProjectionLine } from './autoPostUndoProjection';

/** `audit_log` reasons for the two recorded decisions. */
export const HAND_CORRECTION_REASON = 'auto_post_corrected_by_hand';
export const DECLARED_UNRELATED_REASON = 'auto_post_offset_declared_unrelated';

/** A refused row, described well enough to tell two refused lines apart. */
export interface HandOffset {
  transactionId: string;
  lineDate: string;
  lineAmount: number;
  lineDescription: string;
  journalEntryId: string;
  entryNumber: string;
  entryDate: string;
  amount: number;
  description: string;
  /** Marking it "the correction" is possible only when it nets the posting out. */
  netsPostingOut: boolean;
  reclass: boolean;
  /** Each account, now and after an undo-anyway: the posting gone, the journal left standing. */
  projection: UndoProjectionLine[];
}

export interface OffsetCandidate {
  id: string;
  entryNumber: string;
  entryDate: string;
  amount: number;
  description: string;
  blocks: boolean;
  byPerson: boolean;
  claimedElsewhere: boolean;
  declaredUnrelated: boolean;
  /** Posting + this journal net to zero (within a cent) on every non-bank account of the posting. */
  netsPostingOut: boolean;
  /** It books part of the posting to an account the posting never touched. */
  reclass: boolean;
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
 * ONE set-based query per row, returning at most one journal. Without
 * `onlyJournalId` it is the first journal (by posting time) that blocks the
 * undo; with it, that one journal's evidence whether or not it blocks, for the
 * recorded decisions. The scan is bounded by the posting's NON-bank accounts
 * and its links, never by the bank account, so later bank traffic costs
 * nothing. Every per-candidate check is an indexed EXISTS; the reversal chain
 * is walked only for a journal that has a posted contra at all; and the
 * amount and net are computed for the one row returned.
 */
export async function offsetCandidate(
  companyId: string, postingJeId: string, tx: DbRow, onlyJournalId: string | null = null,
): Promise<OffsetCandidate | null> {
  const txId = String(tx.id);
  const bankAccountId = String(tx.bank_account_id);
  // The posting's own bound and links, read first so they reach the scan as
  // constants rather than a correlated CTE.
  const postingRows = (await sql`
    SELECT COALESCE(posted_at, created_at) AS at, source_document_id
    FROM gl_journal_entries
    WHERE id = ${postingJeId}::UUID AND company_id = ${companyId}::UUID AND status = 'posted'
  `) as DbRow[];
  const posting = postingRows[0];
  if (!posting) return null;
  const postingAt = posting.at as Date | string;
  const postingDoc = posting.source_document_id ? String(posting.source_document_id) : null;
  const rows = (await sql`
    WITH RECURSIVE effect AS (
      SELECT gl_account_id, SUM(debit - credit) AS net
      FROM gl_journal_lines
      WHERE journal_entry_id = ${postingJeId}::UUID AND company_id = ${companyId}::UUID
      GROUP BY gl_account_id
      HAVING SUM(debit - credit) <> 0
    ),
    -- Bounded by POSTING TIME only, never by entry_date: a correction posted
    -- after the auto-posting but dated into the prior period is ordinary
    -- month-end practice, and a date bound let it through (round-3 review).
    -- The speed came from the pre-then-base gating, not from the date (measured:
    -- 8,000 earlier-dated journals cost 4 ms either way).
    pre AS (
      SELECT o.id, o.entry_number, o.entry_date, o.description, o.reversal_of_id,
        COALESCE(o.posted_at, o.created_at) AS at,
        (COALESCE(o.source_record_id = ${txId}::UUID, FALSE)
          OR COALESCE(o.source_document_id = ${postingDoc}::UUID, FALSE)) AS linked,
        (COALESCE(o.source, 'manual') NOT LIKE 'auto_%'
          AND (o.posting_agent IS NULL OR o.posting_agent LIKE 'human%' OR o.posting_agent LIKE 'legacy:human%')) AS by_person
      FROM gl_journal_entries o
      WHERE o.company_id = ${companyId}::UUID AND o.status = 'posted' AND o.id <> ${postingJeId}::UUID
        AND COALESCE(o.posted_at, o.created_at) > ${postingAt}::TIMESTAMPTZ
        AND (${onlyJournalId}::UUID IS NULL OR o.id = ${onlyJournalId}::UUID)
    ),
    -- Per-journal line checks below compare company_id as TEXT on purpose: it
    -- is still the tenant filter, but not an index condition. With it as one,
    -- stale statistics ("the company has one line") chose the
    -- (company_id, gl_account_id) index and read every line of the company for
    -- each candidate — 5.3 s for 8,000 later bank receipts. Keyed on
    -- journal_entry_id alone, each check reads that journal's few lines.
    base AS MATERIALIZED (
      SELECT pr.*,
        EXISTS (
          SELECT 1 FROM gl_journal_lines l JOIN effect e ON e.gl_account_id = l.gl_account_id
          WHERE l.journal_entry_id = pr.id AND l.company_id::TEXT = ${companyId}
            AND l.gl_account_id <> ${bankAccountId}::UUID AND SIGN(l.debit - l.credit) = -SIGN(e.net)
        ) AS moves_expense_back
      FROM pre pr
      -- Cheap columns first: only a linked or person-made journal can block,
      -- so the line checks never run for the system's own journals.
      WHERE pr.reversal_of_id IS NULL AND (${onlyJournalId}::UUID IS NOT NULL OR pr.linked OR pr.by_person)
    ),
    candidate AS (
      SELECT b.*,
        (EXISTS (
          SELECT 1 FROM bank_transactions bt
          WHERE bt.provisional_je_id = b.id AND bt.company_id = ${companyId}::UUID AND bt.id <> ${txId}::UUID
        ) OR EXISTS (
          SELECT 1 FROM gl_journal_lines l
          JOIN bank_transactions bt ON bt.company_id = ${companyId}::UUID AND bt.matched_journal_line_id = l.id
          WHERE l.journal_entry_id = b.id AND l.company_id::TEXT = ${companyId} AND bt.id <> ${txId}::UUID
        ) OR EXISTS (
          SELECT 1 FROM audit_log a
          WHERE a.company_id = ${companyId}::UUID AND a.entity_type = 'bank_transaction' AND a.entity_id <> ${txId}::UUID
            AND a.changes @> jsonb_build_object('metadata',
              jsonb_build_object('reason', ${HAND_CORRECTION_REASON}::TEXT, 'offsetJournalId', b.id::TEXT))
        )) AS claimed_elsewhere,
        EXISTS (
          SELECT 1 FROM audit_log a
          WHERE a.company_id = ${companyId}::UUID AND a.entity_type = 'bank_transaction' AND a.entity_id = ${txId}::UUID
            AND a.changes @> jsonb_build_object('metadata',
              jsonb_build_object('reason', ${DECLARED_UNRELATED_REASON}::TEXT, 'offsetJournalId', b.id::TEXT))
        ) AS declared_unrelated,
        EXISTS (
          SELECT 1 FROM gl_journal_entries r
          WHERE r.company_id = ${companyId}::UUID AND r.reversal_of_id = b.id AND r.status = 'posted'
        ) AS has_contra,
        -- A column, not a WHERE: a correlated check the planner cannot flatten
        -- into a semi-join over every line of the company.
        EXISTS (
          SELECT 1 FROM gl_journal_lines l JOIN effect e ON e.gl_account_id = l.gl_account_id
          WHERE l.journal_entry_id = b.id AND l.company_id::TEXT = ${companyId}
            AND SIGN(l.debit - l.credit) = -SIGN(e.net)
        ) AS moves_back
      FROM base b
      WHERE ${onlyJournalId}::UUID IS NOT NULL OR b.linked OR b.moves_expense_back
    ),
    kept AS (
      SELECT c.*,
        (NOT c.declared_unrelated
          AND (c.linked OR (c.by_person AND NOT c.claimed_elsewhere AND c.moves_expense_back))) AS blocks
      FROM candidate c
      WHERE c.moves_back
    ),
    chain AS (
      SELECT k.id AS root, k.id, 0 AS depth FROM kept k
      WHERE k.has_contra AND (k.blocks OR ${onlyJournalId}::UUID IS NOT NULL)
      UNION ALL
      SELECT ch.root, r.id, ch.depth + 1
      FROM gl_journal_entries r JOIN chain ch ON r.reversal_of_id = ch.id
      WHERE r.company_id = ${companyId}::UUID AND r.status = 'posted' AND ch.depth < 20
    ),
    first AS (
      SELECT k.* FROM kept k
      LEFT JOIN (SELECT root, MAX(depth) AS depth FROM chain GROUP BY root) d ON d.root = k.id
      WHERE (k.blocks OR ${onlyJournalId}::UUID IS NOT NULL)
        -- An odd chain means someone reversed the journal: it is off the books.
        AND (NOT k.has_contra OR d.depth % 2 = 0)
      ORDER BY k.at, k.entry_number
      LIMIT 1
    )
    SELECT f.id, f.entry_number, f.entry_date, f.description, f.blocks, f.by_person,
      f.claimed_elsewhere, f.declared_unrelated,
      (SELECT COALESCE(SUM(debit), 0) FROM gl_journal_lines
        WHERE journal_entry_id = f.id AND company_id = ${companyId}::UUID)::float8 AS amount,
      NOT EXISTS (
        SELECT 1 FROM effect e
        WHERE e.gl_account_id <> ${bankAccountId}::UUID
          AND ABS(e.net + COALESCE((
            SELECT SUM(l.debit - l.credit) FROM gl_journal_lines l
            WHERE l.journal_entry_id = f.id AND l.company_id = ${companyId}::UUID
              AND l.gl_account_id = e.gl_account_id), 0)) >= 0.01
      ) AS nets_posting_out,
      -- It books some of the posting to an account the posting never touched.
      EXISTS (
        SELECT 1 FROM gl_journal_lines l
        WHERE l.journal_entry_id = f.id AND l.company_id = ${companyId}::UUID
          AND l.gl_account_id <> ${bankAccountId}::UUID
          AND l.gl_account_id NOT IN (SELECT gl_account_id FROM effect)
      ) AS reclass
    FROM first f
  `) as DbRow[];

  const r = rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    entryNumber: String(r.entry_number ?? r.id),
    entryDate: fmtDate(r.entry_date),
    amount: Number(r.amount),
    description: String(r.description ?? ''),
    blocks: r.blocks === true,
    byPerson: r.by_person === true,
    claimedElsewhere: r.claimed_elsewhere === true,
    declaredUnrelated: r.declared_unrelated === true,
    netsPostingOut: r.nets_posting_out === true,
    reclass: r.reclass === true,
  };
}

/** Describes `c` as the journal blocking the undo of the bank line `tx`. */
export async function toHandOffset(
  companyId: string, postingJeId: string, tx: DbRow, c: OffsetCandidate,
): Promise<HandOffset> {
  return {
    transactionId: String(tx.id),
    lineDate: fmtDate(tx.transaction_date),
    lineAmount: Number(tx.amount),
    lineDescription: String(tx.description ?? ''),
    journalEntryId: c.id,
    entryNumber: c.entryNumber,
    entryDate: c.entryDate,
    amount: c.amount,
    description: c.description,
    netsPostingOut: c.netsPostingOut,
    reclass: c.reclass,
    projection: await projectUndo(companyId, postingJeId, c.id),
  };
}

/** The first journal that blocks the undo of this row, or null. */
export async function findHandOffset(companyId: string, postingJeId: string, tx: DbRow): Promise<HandOffset | null> {
  const hit = await offsetCandidate(companyId, postingJeId, tx);
  return hit ? toHandOffset(companyId, postingJeId, tx, hit) : null;
}

/**
 * The journal a person already offset this row's posting with (R-079), or
 * null: the undo refuses such a row rather than reverse it on top of their
 * correction.
 */
export async function handOffsetOf(companyId: string, tx: DbRow): Promise<HandOffset | null> {
  const jeId = await postingJournalOf(companyId, tx);
  return jeId ? findHandOffset(companyId, jeId, tx) : null;
}
