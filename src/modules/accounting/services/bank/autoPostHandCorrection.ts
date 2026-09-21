/**
 * R-079 — the two recorded decisions a person makes about a line the undo
 * refused because a later journal may already correct it (autoPostHandOffset).
 *
 * `markCorrectedByHand`: "that journal IS the correction". Posts NOTHING —
 * the ledger already stands as corrected. Accepted only when a person made the
 * journal and, together with the posting, it nets to zero (within a cent) on
 * every non-bank account the posting charged: the K-071 principle, decided by
 * the net. The line keeps its status and journal link (it is still posted, as
 * corrected) and leaves the run.
 *
 * `undoAnyway`: "that journal is NOT the correction". Records the declaration,
 * then undoes the line normally, so the posting is reversed and the unrelated
 * journal stands on its own.
 *
 * Both lock the line first (the undo's lock), write `audit_log` — who, when,
 * the run, the line, the posting and the journal — and record the run undone
 * when no line of it is left tagged.
 */

import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { logAuditOrThrow } from '../core/auditTrailService';
import { lockBankTransactionForUpdate } from './bankTxLock';
import {
  DECLARED_UNRELATED_REASON, HAND_CORRECTION_REASON, offsetCandidate, postingJournalOf,
  type HandOffset, type OffsetCandidate,
} from './autoPostHandOffset';
import { undoRow, type RowOutcome } from './autoPostUndoService';
import { isRetryableContention } from '../core/retryableContention';

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
  /** TRUE when no line of the run is left tagged and the run is now undone. */
  runClosed: boolean;
}

export interface UndoAnywayResult extends HandCorrectionResult {
  /** What the undo of the line came to; `offsetByHand` if ANOTHER journal still blocks it. */
  outcome: RowOutcome | 'offsetByHand';
  handOffset: HandOffset | null;
}

interface Decision { tx: DbRow; postingJeId: string; journal: OffsetCandidate | null }

/** Every refusal here is raised before the first write. */
async function lockForDecision(
  companyId: string, runId: string, txId: string, journalId: string,
): Promise<Decision> {
  const runRows = (await sql`
    SELECT undone_at FROM bank_auto_post_runs
    WHERE id = ${runId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (runRows.length === 0) throw new HandCorrectionRefusedError('Auto-post run not found');
  if (runRows[0]!.undone_at) throw new HandCorrectionRefusedError('Run already undone');
  // The same row lock the undo takes first, so they serialize: whichever comes
  // second finds the line already out of the run.
  const tx = await lockBankTransactionForUpdate(companyId, txId);
  if (!tx || String(tx.auto_post_run_id ?? '') !== runId) {
    throw new HandCorrectionRefusedError('That bank line is no longer part of this run');
  }
  const postingJeId = await postingJournalOf(companyId, tx);
  if (!postingJeId) throw new HandCorrectionRefusedError('That bank line has no auto-posted journal to correct');
  const journal = await offsetCandidate(companyId, postingJeId, tx, journalId);
  return { tx, postingJeId, journal };
}

async function recordDecision(
  companyId: string, userId: string, reason: string, runId: string, d: Decision, journal: OffsetCandidate,
): Promise<void> {
  await logAuditOrThrow({
    companyId,
    userId,
    action: 'update',
    entityType: 'bank_transaction',
    entityId: String(d.tx.id),
    entityRef: journal.entryNumber,
    changes: {
      fields: [{ field: 'auto_post_run_id', old: runId, new: null, label: 'Auto-post run' }],
      metadata: {
        reason, runId, postingJournalId: d.postingJeId,
        offsetJournalId: journal.id, offsetEntryNumber: journal.entryNumber,
      },
    },
  });
}

async function closeRunIfNothingTagged(companyId: string, runId: string, userId: string): Promise<boolean> {
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
  return closed.length > 0;
}

export async function markCorrectedByHand(
  companyId: string, runId: string, txId: string, offsetJournalId: string, userId: string,
): Promise<HandCorrectionResult> {
  const d = await lockForDecision(companyId, runId, txId, offsetJournalId);
  const j = d.journal;
  if (!j || !j.netsPostingOut) {
    throw new HandCorrectionRefusedError(
      'That journal cannot be recorded as the whole correction — with it, every account the posting charged must '
      + 'come back to zero. Reverse that journal first, then undo.',
    );
  }
  if (!j.byPerson) throw new HandCorrectionRefusedError('Only a journal a person posted can be marked as the correction');
  if (j.claimedElsewhere) throw new HandCorrectionRefusedError('That journal already belongs to another bank line');
  if (j.declaredUnrelated) throw new HandCorrectionRefusedError('That journal was declared unrelated to this line');

  await sql`
    UPDATE bank_transactions SET auto_post_run_id = NULL
    WHERE id = ${txId}::UUID AND company_id = ${companyId}::UUID
  `;
  await recordDecision(companyId, userId, HAND_CORRECTION_REASON, runId, d, j);
  const runClosed = await closeRunIfNothingTagged(companyId, runId, userId);
  log.info('Auto-post line marked corrected by hand — nothing posted',
    { companyId, runId, txId, offsetJournalId: j.id, runClosed }, 'auto-post-undo');
  return { transactionId: txId, offsetJournalId: j.id, offsetEntryNumber: j.entryNumber, runClosed };
}

export async function undoAnyway(
  companyId: string, runId: string, txId: string, journalId: string, userId: string,
): Promise<UndoAnywayResult> {
  const d = await lockForDecision(companyId, runId, txId, journalId);
  const j = d.journal;
  if (!j || !j.blocks) throw new HandCorrectionRefusedError('That journal is not blocking the undo of this line');

  // One savepoint around the declaration and the undo: a throw from the
  // reversal takes the declaration back too, so a refusal commits nothing.
  let result: Awaited<ReturnType<typeof undoRow>>;
  try {
    result = await withSavepoint('auto_post_undo_anyway', async () => {
      await recordDecision(companyId, userId, DECLARED_UNRELATED_REASON, runId, d, j);
      const row = await undoRow(companyId, runId, userId, txId);
      // Only these three are an undo, or another blocker to decide next. Any
      // other outcome left the posting live, so the declaration must not stand:
      // throwing here rolls it back with the savepoint.
      if (row.kind === 'reconciled') {
        throw new HandCorrectionRefusedError('That line is reconciled — unreconcile it first, then undo');
      }
      if (row.kind !== 'reversed' && row.kind !== 'alreadyUndone' && row.kind !== 'offsetByHand') {
        throw new HandCorrectionRefusedError('That line cannot be undone as it stands — nothing was recorded');
      }
      return row;
    });
  } catch (err) {
    if (err instanceof HandCorrectionRefusedError || isRetryableContention(err)) throw err;
    // The reversal itself refused — a closed period, say. The savepoint rolled
    // the declaration back with it, so this is a refusal with nothing written,
    // the same `failed` the undo counts; the cause goes to the log, not the user.
    log.error('Undo-anyway could not reverse the line — nothing recorded',
      { companyId, runId, txId, error: err instanceof Error ? err.message : String(err) }, 'auto-post-undo');
    throw new HandCorrectionRefusedError(
      'The line could not be reversed (for example, its period is closed) — nothing was recorded',
    );
  }
  // Closes only when no line is left tagged — so never while this line, still
  // blocked by another journal, or any other line remains in the run.
  const runClosed = await closeRunIfNothingTagged(companyId, runId, userId);
  log.info('Auto-post line undone after its blocking journal was declared unrelated',
    { companyId, runId, txId, journalId: j.id, outcome: result.kind, runClosed }, 'auto-post-undo');
  return {
    transactionId: txId, offsetJournalId: j.id, offsetEntryNumber: j.entryNumber, runClosed,
    outcome: result.kind,
    handOffset: result.kind === 'offsetByHand' ? result.offset : null,
  };
}
