/**
 * Journal tags → bank row (write-through), and its undo.
 *
 * The Banking screen shows a bank transaction's OWN cc1_id / cc2_id / bu_id.
 * Dimension tagging writes the posted journal lines (the source every report
 * reads), so a bank row allocated before the dimensions existed showed blank
 * columns over a tagged journal. These helpers copy the journal's tags onto
 * the bank row allocated to it:
 *
 *   - the journal is the one holding the bank row's matched_journal_line_id;
 *   - its OTHER lines (never the bank leg) that carry any dimension must agree
 *     on ONE (cc1, cc2, bu) set — a split across projects is left alone, the
 *     screen says "Split" for it;
 *   - only rows whose values would change are touched.
 *
 * Every bank row changed is recorded in dimension_tag_batch_bank_rows (mig
 * 889) with its old and new values under a dimension_tag_batches row, so
 * reverse_dimension_tag_batch restores it. Dimensions only: no amount, status,
 * allocation or feed column is named, so trg_bank_tx_feed_state_guard (675)
 * has nothing to refuse.
 *
 * Scope: either the journals a tag batch touched (write-through) or a
 * transaction-date window (sync_bank_dimensions back-fill).
 */
import { sql } from '@/lib/neon';

export interface BankSyncScope {
  /** The tag batch whose journals to sync (write-through). */
  tagBatchId?: string;
  /** Inclusive YYYY-MM-DD window on bank transaction_date (back-fill). */
  dateFrom?: string;
  dateTo?: string;
}

export interface BankSyncCandidate {
  bankTransactionId: string;
  transactionDate: string;
  amount: number;
  description: string;
  old: { cc1Id: string | null; cc2Id: string | null; buId: string | null };
  next: { cc1Id: string | null; cc2Id: string | null; buId: string | null };
}

interface CandidateRow {
  bank_id: string; tx_date: string; amount: string | number; description: string | null;
  o1: string | null; o2: string | null; ob: string | null;
  n1: string | null; n2: string | null; nb: string | null;
}

/**
 * Bank rows in scope whose journal agrees on one dimension set that differs
 * from what the bank row holds. Read-only.
 */
async function selectCandidates(companyId: string, scope: BankSyncScope): Promise<CandidateRow[]> {
  const batchId = scope.tagBatchId ?? null;
  const from = scope.dateFrom ?? null;
  const to = scope.dateTo ?? null;
  return (await sql`
    SELECT bt.id::TEXT AS bank_id, bt.transaction_date::TEXT AS tx_date, bt.amount, bt.description,
           bt.cc1_id::TEXT AS o1, bt.cc2_id::TEXT AS o2, bt.bu_id::TEXT AS ob,
           j.cc1::TEXT AS n1, j.cc2::TEXT AS n2, j.bu::TEXT AS nb
    FROM bank_transactions bt
    JOIN gl_journal_lines bl ON bl.id = bt.matched_journal_line_id AND bl.company_id = bt.company_id
    JOIN LATERAL (
      SELECT (array_agg(al.cc1_id))[1] AS cc1, (array_agg(al.cc2_id))[1] AS cc2, (array_agg(al.bu_id))[1] AS bu
      FROM gl_journal_lines al
      WHERE al.journal_entry_id = bl.journal_entry_id AND al.company_id = bl.company_id AND al.id <> bl.id
        AND (al.cc1_id IS NOT NULL OR al.cc2_id IS NOT NULL OR al.bu_id IS NOT NULL)
      HAVING COUNT(DISTINCT ROW(al.cc1_id, al.cc2_id, al.bu_id)) = 1
    ) j ON TRUE
    WHERE bt.company_id = ${companyId}::UUID
      AND (${batchId}::UUID IS NULL OR bl.journal_entry_id IN (
            SELECT tl.journal_entry_id FROM dimension_tag_batch_lines b
            JOIN gl_journal_lines tl ON tl.id = b.journal_line_id AND tl.company_id = b.company_id
            WHERE b.batch_id = ${batchId}::UUID AND b.company_id = ${companyId}::UUID))
      AND (${from}::DATE IS NULL OR bt.transaction_date >= ${from}::DATE)
      AND (${to}::DATE IS NULL OR bt.transaction_date <= ${to}::DATE)
      AND (bt.cc1_id IS DISTINCT FROM j.cc1 OR bt.cc2_id IS DISTINCT FROM j.cc2 OR bt.bu_id IS DISTINCT FROM j.bu)
    ORDER BY bt.transaction_date, bt.id
  `) as CandidateRow[];
}

/** Preview: how many bank rows would change, and the first `sample` of them. */
export async function previewBankSync(
  companyId: string, scope: BankSyncScope, sample = 25,
): Promise<{ count: number; sample: BankSyncCandidate[] }> {
  const rows = await selectCandidates(companyId, scope);
  return {
    count: rows.length,
    sample: rows.slice(0, sample).map((r) => ({
      bankTransactionId: r.bank_id,
      transactionDate: r.tx_date,
      amount: Number(r.amount),
      description: r.description ?? '',
      old: { cc1Id: r.o1, cc2Id: r.o2, buId: r.ob },
      next: { cc1Id: r.n1, cc2Id: r.n2, buId: r.nb },
    })),
  };
}

/**
 * Record and apply the bank-row changes for `scope` under `batchId`. Returns
 * the number of bank rows changed. Runs inside the caller's transaction.
 */
export async function applyBankSync(companyId: string, batchId: string, scope: BankSyncScope): Promise<number> {
  const rows = await selectCandidates(companyId, scope);
  if (rows.length === 0) return 0;
  const col = <T>(f: (r: CandidateRow) => T): T[] => rows.map(f);
  await sql`
    INSERT INTO dimension_tag_batch_bank_rows (
      batch_id, company_id, bank_transaction_id, old_cc1_id, old_cc2_id, old_bu_id, new_cc1_id, new_cc2_id, new_bu_id
    )
    SELECT ${batchId}::UUID, ${companyId}::UUID, t.id, t.o1, t.o2, t.ob, t.n1, t.n2, t.nb
    FROM unnest(
      ${col((r) => r.bank_id)}::UUID[],
      ${col((r) => r.o1)}::UUID[], ${col((r) => r.o2)}::UUID[], ${col((r) => r.ob)}::UUID[],
      ${col((r) => r.n1)}::UUID[], ${col((r) => r.n2)}::UUID[], ${col((r) => r.nb)}::UUID[]
    ) AS t(id, o1, o2, ob, n1, n2, nb)
  `;
  await sql`
    UPDATE bank_transactions bt
    SET cc1_id = br.new_cc1_id, cc2_id = br.new_cc2_id, bu_id = br.new_bu_id
    FROM dimension_tag_batch_bank_rows br
    WHERE br.batch_id = ${batchId}::UUID AND br.company_id = ${companyId}::UUID
      AND bt.id = br.bank_transaction_id AND bt.company_id = ${companyId}::UUID
  `;
  return rows.length;
}

/**
 * The back-fill (sync_bank_dimensions): one dimension_tag_batches row (no
 * journal lines, line_count 0) holding the bank rows changed, so
 * reverse_dimension_tag_batch undoes it like any tag batch. No batch is
 * written when nothing would change.
 */
export async function applyBankSyncBatch(
  companyId: string, scope: BankSyncScope, opts: { idempotencyKey: string; reason?: string; userId: string },
): Promise<{ batchId: string | null; bankRowCount: number }> {
  if ((await selectCandidates(companyId, scope)).length === 0) return { batchId: null, bankRowCount: 0 };
  const [batch] = (await sql`
    INSERT INTO dimension_tag_batches (company_id, idempotency_key, reason, is_restatement, line_count, created_by)
    VALUES (${companyId}::UUID, ${opts.idempotencyKey}, ${opts.reason ?? 'sync bank dimensions from journal'}, false, 0, ${opts.userId})
    RETURNING id::TEXT AS id
  `) as { id: string }[];
  const bankRowCount = await applyBankSync(companyId, batch!.id, scope);
  return { batchId: batch!.id, bankRowCount };
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
