/**
 * R-079 — a person confirms that a manual journal is the correction of an
 * auto-posted row, so the undo must not reverse it.
 *
 * The undo refuses a row that a manual journal already offsets (see
 * autoPostHandOffset.ts) and names that journal. The user then either
 * reverses their journal and undoes again, or confirms it here. Confirming
 * posts NOTHING: the ledger already stands as the user corrected it. The row
 * leaves the run (its tag is cleared, its status and journal link are kept —
 * the line IS still posted, as corrected) and the confirmation is recorded in
 * `audit_log`: who, when, the run, the posting and the journal they named.
 * When no row of the run is left tagged, the run is recorded undone.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '../core/auditTrailService';
import { lockBankTransactionForUpdate } from './bankTxLock';
import { HAND_CORRECTION_REASON, offsetCandidates, postingJournalOf } from './autoPostHandOffset';

/** A refusal written for the person who asked; nothing was written. */
export class HandCorrectionRefusedError extends Error {
  readonly code = 'HAND_CORRECTION_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'HandCorrectionRefusedError';
  }
}

export interface HandCorrectionResult {
  transactionId: string;
  offsetJournalId: string;
  offsetEntryNumber: string;
  /** TRUE when this was the run's last tagged row and the run is now undone. */
  runClosed: boolean;
}

export async function markCorrectedByHand(
  companyId: string, runId: string, txId: string, offsetJournalId: string, userId: string,
): Promise<HandCorrectionResult> {
  const runRows = (await sql`
    SELECT undone_at FROM bank_auto_post_runs
    WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (runRows.length === 0) throw new HandCorrectionRefusedError('Auto-post run not found');
  if (runRows[0]!.undone_at) throw new HandCorrectionRefusedError('Run already undone');

  // The same row lock the undo takes first, so the two serialize: whichever
  // comes second finds the row already out of the run.
  const tx = await lockBankTransactionForUpdate(companyId, txId);
  if (!tx || String(tx.auto_post_run_id ?? '') !== runId) {
    throw new HandCorrectionRefusedError('That bank line is no longer part of this run');
  }
  const postingJeId = await postingJournalOf(companyId, tx);
  if (!postingJeId) throw new HandCorrectionRefusedError('That bank line has no auto-posted journal to correct');

  // The named journal must actually be an offset of this posting: posted, in
  // this company, after the posting, not a reversal, still on the books, and
  // moving one of the posting's own accounts back. So the override cannot
  // close a row that nothing offsets.
  const [offset] = await offsetCandidates(companyId, postingJeId, txId, offsetJournalId);
  if (!offset) {
    throw new HandCorrectionRefusedError(
      'That journal does not offset this posting — it must be posted after it and move its accounts back',
    );
  }
  // One journal corrects one line: a journal another bank line already owns
  // (its allocation, or its confirmed correction) cannot close this one too.
  if (offset.claimedElsewhere) {
    throw new HandCorrectionRefusedError('That journal already belongs to another bank line');
  }

  await sql`
    UPDATE bank_transactions SET auto_post_run_id = NULL
    WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
  `;
  await logAuditOrThrow({
    companyId,
    userId,
    action: 'update',
    entityType: 'bank_transaction',
    entityId: txId,
    entityRef: offset.entryNumber,
    changes: {
      fields: [{ field: 'auto_post_run_id', old: runId, new: null, label: 'Auto-post run' }],
      metadata: {
        reason: HAND_CORRECTION_REASON,
        runId,
        postingJournalId: postingJeId,
        offsetJournalId: offset.id,
        offsetEntryNumber: offset.entryNumber,
      },
    },
  });

  const closed = (await sql`
    UPDATE bank_auto_post_runs
    SET undone_at = NOW(), undone_by = ${userId}::UUID
    WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID AND undone_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM bank_transactions
        WHERE auto_post_run_id = ${runId}::UUID AND company_id = ${companyId}::UUID
      )
    RETURNING id
  `) as DbRow[];

  log.info(
    'Auto-post row confirmed as corrected by hand — nothing posted',
    { companyId, runId, txId, postingJeId, offsetJournalId: offset.id, runClosed: closed.length > 0 },
    'auto-post-undo',
  );
  return {
    transactionId: txId,
    offsetJournalId: offset.id,
    offsetEntryNumber: offset.entryNumber,
    runClosed: closed.length > 0,
  };
}
