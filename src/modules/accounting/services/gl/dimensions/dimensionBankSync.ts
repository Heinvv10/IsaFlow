/**
 * Journal tags → bank row (write-through), and its undo.
 *
 * The Banking screen shows a bank transaction's OWN cc1_id / cc2_id / bu_id.
 * Dimension tagging writes the posted journal lines (the source every report
 * reads), so a bank row allocated before the dimensions existed showed blank
 * columns over a tagged journal. These helpers MIRROR the journal onto the
 * bank row allocated to it:
 *
 *   - the journal is the POSTED one holding the bank row's matched_journal_line_id;
 *   - its dimension lines (journalDimensionSetSql.ts: every line but the bank
 *     leg that is not on a control account) must agree on ONE (cc1, cc2, bu)
 *     set — a split across projects, or a partial tagging (one line tagged, one
 *     not), is left alone and the screen says "Split";
 *   - the bank row then takes exactly that set, NULLs included: a journal tagged
 *     CC1-only BLANKS the row's CC2 and BU. Only rows whose values differ are
 *     touched, and every row where a value becomes NULL is reported before the
 *     live call (`blanks`);
 *   - write-through (a tag batch's journals): a journal whose tags were all
 *     removed agrees on (NULL, NULL, NULL), so the bank row is cleared;
 *   - back-fill (a date window): a journal carrying no dimension at all (a
 *     supplier payment is AP + bank; an untagged expense) is left alone — the
 *     bank row's own tags are all it has there, and nothing says they are stale.
 *
 * The live path locks the candidate rows (FOR UPDATE OF bt, in id order, so two
 * syncs cannot deadlock) and writes each only if it still holds the old values
 * it was planned from; any row that does not, or a window over MAX_BANK_SYNC_ROWS,
 * is a BankDimensionSyncRefusal thrown past the first write so the registry's
 * savepoint rolls the batch back.
 *
 * Every bank row changed is recorded in dimension_tag_batch_bank_rows (mig 889)
 * with its old and new values under a dimension_tag_batches row, so
 * reverse_dimension_tag_batch restores it. Dimensions only: no amount, status,
 * allocation or feed column is named, so trg_bank_tx_feed_state_guard (675)
 * has nothing to refuse.
 */
import { sql } from '@/lib/neon';
import { JOURNAL_DIMENSION_SET_LATERAL } from './journalDimensionSetSql';
import {
  BankDimensionSyncRefusal, MAX_BANK_SYNC_ROWS, blankedSlots,
  type BankSyncCandidate, type BankSyncScope,
} from './dimensionBankSyncTypes';

export { MAX_BANK_SYNC_ROWS, BankDimensionSyncRefusal, blankedSlots };
export type { BankSyncCandidate, BankSyncScope };

interface CandidateRow {
  bank_id: string; tx_date: string; amount: string | number; description: string | null;
  o1: string | null; o2: string | null; ob: string | null;
  n1: string | null; n2: string | null; nb: string | null;
  total: string | number;
}

const toCandidate = (r: CandidateRow): BankSyncCandidate => {
  const old = { cc1Id: r.o1, cc2Id: r.o2, buId: r.ob };
  const next = { cc1Id: r.n1, cc2Id: r.n2, buId: r.nb };
  return {
    bankTransactionId: r.bank_id, transactionDate: r.tx_date, amount: Number(r.amount),
    description: r.description ?? '', old, next, blanks: blankedSlots(old, next),
  };
};

/**
 * Bank rows in scope whose journal agrees on one dimension set that differs from
 * what the bank row holds, in id order, at most `limit`. `total` is the full
 * count (read-only variant only; the locking variant cannot carry a window
 * function and reports 0).
 */
async function selectCandidates(
  companyId: string, scope: BankSyncScope, opts: { lock: boolean; limit: number },
): Promise<{ rows: BankSyncCandidate[]; total: number }> {
  const batchId = scope.tagBatchId ?? null;
  const from = scope.dateFrom ?? null;
  const to = scope.dateTo ?? null;
  if (batchId === null && (from === null || to === null)) {
    throw new BankDimensionSyncRefusal('A bank sync needs a tag batch or a date window.');
  }
  const rows = (await sql`
    SELECT bt.id::TEXT AS bank_id, bt.transaction_date::TEXT AS tx_date, bt.amount, bt.description,
           bt.cc1_id::TEXT AS o1, bt.cc2_id::TEXT AS o2, bt.bu_id::TEXT AS ob,
           jd.cc1::TEXT AS n1, jd.cc2::TEXT AS n2, jd.bu::TEXT AS nb,
           ${sql.unsafe(opts.lock ? '0' : 'COUNT(*) OVER ()')} AS total
    FROM bank_transactions bt
    ${sql.unsafe(JOURNAL_DIMENSION_SET_LATERAL)}
    WHERE bt.company_id = ${companyId}::UUID
      AND jd.sets = 1
      AND (${batchId}::UUID IS NOT NULL OR jd.tagged > 0)
      AND (${batchId}::UUID IS NULL OR EXISTS (
            SELECT 1 FROM gl_journal_lines mbl
            WHERE mbl.id = bt.matched_journal_line_id AND mbl.company_id = bt.company_id
              AND mbl.journal_entry_id IN (
                SELECT tl.journal_entry_id FROM dimension_tag_batch_lines b
                JOIN gl_journal_lines tl ON tl.id = b.journal_line_id AND tl.company_id = b.company_id
                WHERE b.batch_id = ${batchId}::UUID AND b.company_id = ${companyId}::UUID)))
      AND (${from}::DATE IS NULL OR bt.transaction_date >= ${from}::DATE)
      AND (${to}::DATE IS NULL OR bt.transaction_date <= ${to}::DATE)
      AND (bt.cc1_id IS DISTINCT FROM jd.cc1 OR bt.cc2_id IS DISTINCT FROM jd.cc2 OR bt.bu_id IS DISTINCT FROM jd.bu)
    ORDER BY bt.id
    LIMIT ${opts.limit}::INT
    ${sql.unsafe(opts.lock ? 'FOR UPDATE OF bt' : '')}
  `) as CandidateRow[];
  return { rows: rows.map(toCandidate), total: rows.length === 0 ? 0 : Number(rows[0]!.total) };
}

const byDateThenId = (a: BankSyncCandidate, b: BankSyncCandidate): number =>
  a.transactionDate.localeCompare(b.transactionDate) || a.bankTransactionId.localeCompare(b.bankTransactionId);

export interface BankSyncPreview {
  /** Every bank row that would change. */
  count: number;
  /** True when `count` is over `maxRows`: the live call would refuse; narrow the window. */
  overMaxRows: boolean;
  maxRows: number;
  sample: BankSyncCandidate[];
  /** Every row (of the first `maxRows`) where a value now held would become NULL. */
  blanking: BankSyncCandidate[];
}

/** Preview: how many bank rows would change, the first `sample` of them, and every row that would lose a value. Read-only. */
export async function previewBankSync(
  companyId: string, scope: BankSyncScope, opts: { sample?: number; maxRows?: number } = {},
): Promise<BankSyncPreview> {
  const maxRows = opts.maxRows ?? MAX_BANK_SYNC_ROWS;
  const { rows, total } = await selectCandidates(companyId, scope, { lock: false, limit: maxRows + 1 });
  const listed = rows.slice(0, maxRows).sort(byDateThenId);
  return {
    count: total, overMaxRows: total > maxRows, maxRows,
    sample: listed.slice(0, opts.sample ?? 25), blanking: listed.filter((r) => r.blanks.length > 0),
  };
}

/** Candidate rows locked for update, in id order; refused when there are more than `maxRows`. */
async function lockCandidates(companyId: string, scope: BankSyncScope, maxRows: number): Promise<BankSyncCandidate[]> {
  const { rows } = await selectCandidates(companyId, scope, { lock: true, limit: maxRows + 1 });
  if (rows.length > maxRows) {
    throw new BankDimensionSyncRefusal(
      `This sync would change more than ${maxRows} bank transactions: narrow date_from / date_to and run it in parts `
      + '(dry_run reports the total).',
    );
  }
  return rows;
}

/**
 * Record `rows` under `batchId` and write them, each only if it still holds the
 * old values it was planned from. A row that does not (changed since it was
 * read) throws, so nothing of the batch survives the caller's savepoint.
 */
export async function writeBankRows(companyId: string, batchId: string, rows: BankSyncCandidate[]): Promise<number> {
  if (rows.length === 0) return 0;
  const col = <T>(f: (r: BankSyncCandidate) => T): T[] => rows.map(f);
  await sql`
    INSERT INTO dimension_tag_batch_bank_rows (
      batch_id, company_id, bank_transaction_id, old_cc1_id, old_cc2_id, old_bu_id, new_cc1_id, new_cc2_id, new_bu_id
    )
    SELECT ${batchId}::UUID, ${companyId}::UUID, t.id, t.o1, t.o2, t.ob, t.n1, t.n2, t.nb
    FROM unnest(
      ${col((r) => r.bankTransactionId)}::UUID[],
      ${col((r) => r.old.cc1Id)}::UUID[], ${col((r) => r.old.cc2Id)}::UUID[], ${col((r) => r.old.buId)}::UUID[],
      ${col((r) => r.next.cc1Id)}::UUID[], ${col((r) => r.next.cc2Id)}::UUID[], ${col((r) => r.next.buId)}::UUID[]
    ) AS t(id, o1, o2, ob, n1, n2, nb)
  `;
  const written = (await sql`
    UPDATE bank_transactions bt
    SET cc1_id = br.new_cc1_id, cc2_id = br.new_cc2_id, bu_id = br.new_bu_id
    FROM dimension_tag_batch_bank_rows br
    WHERE br.batch_id = ${batchId}::UUID AND br.company_id = ${companyId}::UUID
      AND bt.id = br.bank_transaction_id AND bt.company_id = ${companyId}::UUID
      AND bt.cc1_id IS NOT DISTINCT FROM br.old_cc1_id AND bt.cc2_id IS NOT DISTINCT FROM br.old_cc2_id
      AND bt.bu_id IS NOT DISTINCT FROM br.old_bu_id
    RETURNING bt.id
  `) as { id: string }[];
  if (written.length !== rows.length) {
    throw new BankDimensionSyncRefusal(
      `${rows.length - written.length} bank transaction(s) were changed by another request while this sync ran; `
      + 'nothing was synced. Run it again.',
    );
  }
  return written.length;
}

/**
 * Record and apply the bank-row changes for `scope` under `batchId` (the
 * write-through of a tag batch). Returns the number of bank rows changed. Runs
 * inside the caller's transaction.
 */
export async function applyBankSync(
  companyId: string, batchId: string, scope: BankSyncScope, opts: { maxRows?: number } = {},
): Promise<number> {
  return writeBankRows(companyId, batchId, await lockCandidates(companyId, scope, opts.maxRows ?? MAX_BANK_SYNC_ROWS));
}

/**
 * The back-fill (sync_bank_dimensions): one dimension_tag_batches row (no
 * journal lines, line_count 0, the window recorded so a replay can be checked
 * against it) holding the bank rows changed, so reverse_dimension_tag_batch
 * undoes it like any tag batch. No batch is written when nothing would change.
 */
export async function applyBankSyncBatch(
  companyId: string, scope: BankSyncScope & { dateFrom: string; dateTo: string },
  opts: { idempotencyKey: string; reason?: string; userId: string; maxRows?: number },
): Promise<{ batchId: string | null; bankRowCount: number }> {
  const rows = await lockCandidates(companyId, scope, opts.maxRows ?? MAX_BANK_SYNC_ROWS);
  if (rows.length === 0) return { batchId: null, bankRowCount: 0 };
  const [batch] = (await sql`
    INSERT INTO dimension_tag_batches (
      company_id, idempotency_key, reason, is_restatement, line_count, created_by, sync_date_from, sync_date_to
    )
    VALUES (${companyId}::UUID, ${opts.idempotencyKey}, ${opts.reason ?? 'sync bank dimensions from journal'}, false, 0,
            ${opts.userId}, ${scope.dateFrom}::DATE, ${scope.dateTo}::DATE)
    RETURNING id::TEXT AS id
  `) as { id: string }[];
  const bankRowCount = await writeBankRows(companyId, batch!.id, rows);
  return { batchId: batch!.id, bankRowCount };
}

/** Bank rows the batch changed. */
export async function countBankRows(companyId: string, batchId: string): Promise<number> {
  const [r] = (await sql`
    SELECT COUNT(*)::INT AS n FROM dimension_tag_batch_bank_rows
    WHERE batch_id = ${batchId}::UUID AND company_id = ${companyId}::UUID
  `) as { n: number }[];
  return Number(r?.n ?? 0);
}

/** Bank rows of the batch changed since it ran (current ≠ the batch's new values). */
export async function countBankRowDrift(companyId: string, batchId: string): Promise<number> {
  const [r] = (await sql`
    SELECT COUNT(*)::INT AS n FROM dimension_tag_batch_bank_rows br
    JOIN bank_transactions bt ON bt.id = br.bank_transaction_id AND bt.company_id = br.company_id
    WHERE br.batch_id = ${batchId}::UUID AND br.company_id = ${companyId}::UUID
      AND (bt.cc1_id IS DISTINCT FROM br.new_cc1_id OR bt.cc2_id IS DISTINCT FROM br.new_cc2_id
           OR bt.bu_id IS DISTINCT FROM br.new_bu_id)
  `) as { n: number }[];
  return Number(r?.n ?? 0);
}

/** Put every bank row of the batch back to its old values. */
export async function restoreBankRows(companyId: string, batchId: string): Promise<void> {
  await sql`
    UPDATE bank_transactions bt
    SET cc1_id = br.old_cc1_id, cc2_id = br.old_cc2_id, bu_id = br.old_bu_id
    FROM dimension_tag_batch_bank_rows br
    WHERE br.batch_id = ${batchId}::UUID AND br.company_id = ${companyId}::UUID
      AND bt.id = br.bank_transaction_id AND bt.company_id = ${companyId}::UUID
  `;
}
