/**
 * Dimension-only tagging — the WRITE half, and its undo.
 *
 * `applyDimensionTags` writes one dimension_tag_batches row, one
 * dimension_tag_batch_lines row per changed line (old AND new values), then
 * UPDATEs exactly cc1_id / cc2_id / bu_id on those lines from the batch rows.
 * No other column is named, so an amount, account or date cannot move.
 *
 * `reverseDimensionTagBatch` restores the OLD values — refused when any line
 * has been re-tagged since (its current values no longer equal the batch's
 * new ones), because restoring then would silently undo the later batch. The
 * later batch is reversed first.
 *
 * Both halves carry the bank rows along (dimensionBankSync.ts): a batch copies
 * the tags onto the bank row allocated to each journal it touched, and its
 * reversal restores those rows, so the Banking screen never disagrees with the
 * journal.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { UUID_RE } from '@/lib/validation';
import { DimensionRefusal } from './dimensionTypes';
import type { TagPlan } from './dimensionTagPlan';
import {
  applyBankSync, countBankRowDrift, countBankRows, lockBatchBankRows, restoreBankRows, withBoundedStatements,
} from './dimensionBankSync';
import { BankDimensionSyncRefusal } from './dimensionBankSyncTypes';

export interface AppliedTagBatch {
  batchId: string; lineCount: number; isRestatement: boolean; bankRowCount?: number;
  /** Set on a sync_bank_dimensions batch: the bank transaction_date window it ran over. */
  sync?: { dateFrom: string; dateTo: string };
}

/** An earlier batch under the same key, if any — the replay answer. */
export async function findTagBatchByKey(companyId: string, key: string): Promise<AppliedTagBatch | null> {
  const rows = (await sql`
    SELECT id::TEXT AS id, line_count, is_restatement, sync_date_from::TEXT AS sync_from, sync_date_to::TEXT AS sync_to
    FROM dimension_tag_batches
    WHERE company_id = ${companyId}::UUID AND idempotency_key = ${key}
  `) as { id: string; line_count: number; is_restatement: boolean; sync_from: string | null; sync_to: string | null }[];
  const r = rows[0];
  if (!r) return null;
  return {
    batchId: r.id, lineCount: Number(r.line_count), isRestatement: r.is_restatement === true,
    ...(r.sync_from && r.sync_to ? { sync: { dateFrom: r.sync_from, dateTo: r.sync_to } } : {}),
  };
}

/**
 * An idempotency key names ONE batch, of one kind and (for a sync) one window.
 * A tool replays only its own: the other kind, or a sync of another window, is
 * refused with the remedy, never answered as if it were the call that ran.
 */
export function assertKeyIsFor(
  prior: AppliedTagBatch, key: string, mine: 'tag_journal_lines' | { dateFrom: string; dateTo: string },
): void {
  const fresh = 'Use a fresh idempotency_key.';
  if (mine === 'tag_journal_lines') {
    if (prior.sync) throw new BankDimensionSyncRefusal(`idempotency_key ${key} already names a sync_bank_dimensions batch. ${fresh}`);
    return;
  }
  if (!prior.sync) throw new BankDimensionSyncRefusal(`idempotency_key ${key} already names a tag_journal_lines batch. ${fresh}`);
  if (prior.sync.dateFrom !== mine.dateFrom || prior.sync.dateTo !== mine.dateTo) {
    throw new BankDimensionSyncRefusal(
      `idempotency_key ${key} already names a sync_bank_dimensions batch for ${prior.sync.dateFrom} to ${prior.sync.dateTo}, `
      + `not ${mine.dateFrom} to ${mine.dateTo}. ${fresh}`,
    );
  }
}

export async function applyDimensionTags(
  companyId: string,
  plan: TagPlan,
  opts: { idempotencyKey: string; reason?: string; userId: string },
): Promise<AppliedTagBatch> {
  const [batch] = (await sql`
    INSERT INTO dimension_tag_batches (company_id, idempotency_key, reason, is_restatement, line_count, created_by)
    VALUES (${companyId}::UUID, ${opts.idempotencyKey}, ${opts.reason ?? null}, ${plan.isRestatement},
            ${plan.lines.length}, ${opts.userId})
    RETURNING id::TEXT AS id
  `) as { id: string }[];
  const batchId = batch!.id;
  const col = <T>(f: (l: TagPlan['lines'][number]) => T): T[] => plan.lines.map(f);
  await sql`
    INSERT INTO dimension_tag_batch_lines (
      batch_id, company_id, journal_line_id, old_cc1_id, old_cc2_id, old_bu_id,
      new_cc1_id, new_cc2_id, new_bu_id, unallocated_reason, period_closed
    )
    SELECT ${batchId}::UUID, ${companyId}::UUID, t.line_id, t.o1, t.o2, t.ob, t.n1, t.n2, t.nb, t.reason, t.closed
    FROM unnest(
      ${col((l) => l.journalLineId)}::UUID[],
      ${col((l) => l.old.cc1Id ?? null)}::UUID[], ${col((l) => l.old.cc2Id ?? null)}::UUID[],
      ${col((l) => l.old.buId ?? null)}::UUID[],
      ${col((l) => l.next.cc1Id ?? null)}::UUID[], ${col((l) => l.next.cc2Id ?? null)}::UUID[],
      ${col((l) => l.next.buId ?? null)}::UUID[],
      ${col((l) => l.unallocatedReason)}::TEXT[], ${col((l) => l.periodClosed)}::BOOLEAN[]
    ) AS t(line_id, o1, o2, ob, n1, n2, nb, reason, closed)
  `;
  await sql`
    UPDATE gl_journal_lines jl
    SET cc1_id = bl.new_cc1_id, cc2_id = bl.new_cc2_id, bu_id = bl.new_bu_id
    FROM dimension_tag_batch_lines bl
    WHERE bl.batch_id = ${batchId}::UUID AND bl.company_id = ${companyId}::UUID
      AND jl.id = bl.journal_line_id AND jl.company_id = ${companyId}::UUID
  `;
  const bankRowCount = await applyBankSync(companyId, batchId, { tagBatchId: batchId });
  log.info('Dimension tag batch applied', {
    companyId, batchId, lineCount: plan.lines.length, bankRowCount, isRestatement: plan.isRestatement,
  }, 'accounting');
  return { batchId, lineCount: plan.lines.length, isRestatement: plan.isRestatement, bankRowCount };
}

export interface TagBatchReversalPlan { batchId: string; lineCount: number; bankRowCount: number; isRestatement: boolean }

/**
 * Lock the journal lines a batch tagged, in id order, BEFORE its bank rows (lockBatchBankRows): tagging writes the lines
 * and then the bank rows, so a reversal that locked them the other way round could deadlock with it (40P01).
 */
async function lockBatchJournalLines(companyId: string, batchId: string): Promise<void> {
  await sql`
    SELECT jl.id FROM gl_journal_lines jl
    WHERE jl.company_id = ${companyId}::UUID
      AND jl.id IN (SELECT bl.journal_line_id FROM dimension_tag_batch_lines bl
                    WHERE bl.batch_id = ${batchId}::UUID AND bl.company_id = ${companyId}::UUID)
    ORDER BY jl.id
    FOR UPDATE OF jl
  `;
}

/** Every refusal, from reads under a row lock on the batch. */
export async function planTagBatchReversal(companyId: string, batchId: string): Promise<TagBatchReversalPlan> {
  if (!UUID_RE.test(batchId)) throw new DimensionRefusal('batch_id must be a UUID');
  const [batch] = (await sql`
    SELECT id::TEXT AS id, reversed_at, line_count, is_restatement FROM dimension_tag_batches
    WHERE id = ${batchId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `) as { id: string; reversed_at: unknown; line_count: number; is_restatement: boolean }[];
  if (!batch) throw new DimensionRefusal('Not found');
  if (batch.reversed_at) throw new DimensionRefusal(`Dimension tag batch ${batchId} is already reversed`);
  // Lines, then bank rows (the order tagging writes them in), each in id order, held to commit and bounded like the
  // forward path: nothing can change a line or a bank row between the drift checks and the restore.
  await withBoundedStatements(async () => {
    await lockBatchJournalLines(companyId, batchId);
    await lockBatchBankRows(companyId, batchId);
  }, undefined, { what: 'reversal lock wait', remedy: 'another request is changing lines or bank rows of this batch; run the reversal again' });
  const [drift] = (await sql`
    SELECT COUNT(*)::INT AS n FROM dimension_tag_batch_lines bl
    JOIN gl_journal_lines jl ON jl.id = bl.journal_line_id AND jl.company_id = bl.company_id
    WHERE bl.batch_id = ${batchId}::UUID AND bl.company_id = ${companyId}::UUID
      AND (jl.cc1_id IS DISTINCT FROM bl.new_cc1_id OR jl.cc2_id IS DISTINCT FROM bl.new_cc2_id
           OR jl.bu_id IS DISTINCT FROM bl.new_bu_id)
  `) as { n: number }[];
  if (Number(drift?.n ?? 0) > 0) {
    throw new DimensionRefusal(
      `${Number(drift!.n)} line(s) of batch ${batchId} were re-tagged after it; reverse the later batch first.`,
    );
  }
  const bankDrift = await countBankRowDrift(companyId, batchId);
  if (bankDrift > 0) {
    throw new DimensionRefusal(
      `${bankDrift} bank transaction(s) of batch ${batchId} were re-tagged after it; reverse the later batch first.`,
    );
  }
  return {
    batchId, lineCount: Number(batch.line_count), bankRowCount: await countBankRows(companyId, batchId),
    isRestatement: batch.is_restatement === true,
  };
}

export async function applyTagBatchReversal(
  companyId: string, plan: TagBatchReversalPlan, opts: { userId: string; reason?: string },
): Promise<void> {
  await sql`
    UPDATE gl_journal_lines jl
    SET cc1_id = bl.old_cc1_id, cc2_id = bl.old_cc2_id, bu_id = bl.old_bu_id
    FROM dimension_tag_batch_lines bl
    WHERE bl.batch_id = ${plan.batchId}::UUID AND bl.company_id = ${companyId}::UUID
      AND jl.id = bl.journal_line_id AND jl.company_id = ${companyId}::UUID
  `;
  await restoreBankRows(companyId, plan.batchId);
  await sql`
    UPDATE dimension_tag_batches
    SET reversed_at = NOW(), reversed_by = ${opts.userId}, reversal_reason = ${opts.reason ?? null}
    WHERE id = ${plan.batchId}::UUID AND company_id = ${companyId}::UUID
  `;
  log.info('Dimension tag batch reversed', {
    companyId, batchId: plan.batchId, lineCount: plan.lineCount, bankRowCount: plan.bankRowCount,
  }, 'accounting');
}
