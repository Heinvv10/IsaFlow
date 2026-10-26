/**
 * One row of `undoRun` (autoPostUndoService), counted by outcome. Split out of that file (300-line cap) when the
 * credit retry arrived (2026-10-26).
 *
 * A row whose void would take a supplier's on-account credit below zero (`ap/supplierVoidCredit`: a refund already
 * returned the payment's cash) is NOT counted here: it answers 'creditRefused', and the run tries it again once
 * every other row is done. A run that reverses a payment AND its refund reaches them in id order, so the payment
 * can come first and be refused only because the refund is still standing; on the second try the refund's undo has
 * raised the credit back. Refused again — the refund is not in the run, or was skipped — it is a `creditCeiling`
 * skip and the run stays open (Hein's ruling 2026-10-26: such a void is refused).
 */
import { log } from '@/lib/logger';
import { isHeldRowError } from '@/lib/lockTimeout';
import { isRetryableContention } from '../core/retryableContention';
import { isVoidCreditRefusal } from '../ap/supplierVoidCredit';
import type { HandOffset } from './autoPostHandOffset';
import type { RowResult, UndoSkips } from './autoPostUndoService';

export interface UndoTally {
  reversed: number;
  alreadyUndone: number;
  skippedBy: UndoSkips;
  handOffsets: HandOffset[];
  /** The first contention met, kept only to decide the run's answer. */
  contention: unknown;
}

/**
 * Runs `undo` (one row, under its own savepoint) and counts what it came to. `final` is the retry: a credit
 * refusal there is counted as a `creditCeiling` skip instead of being handed back.
 */
export async function attemptUndoRow(
  ctx: { companyId: string; runId: string; txId: string; status: string },
  tally: UndoTally,
  undo: () => Promise<RowResult>,
  final: boolean,
): Promise<'counted' | 'creditRefused'> {
  const { companyId, runId, txId } = ctx;
  try {
    const result = await undo();
    const outcome = result.kind;
    if (result.kind === 'offsetByHand') {
      tally.skippedBy.offsetByHand += 1;
      tally.handOffsets.push(result.offset);
      log.warn(
        'Auto-post undo refused a transaction a manual journal already offsets — nothing posted; run stays open',
        { companyId, runId, txId, offsetJournalId: result.offset.journalEntryId },
        'auto-post-undo',
      );
    } else if (outcome === 'gone') {
      // A peer undo or a confirmed hand correction finished it first.
    } else if (outcome === 'reconciled') {
      tally.skippedBy.reconciled += 1;
    } else if (outcome === 'reversed') {
      tally.reversed += 1;
    } else if (outcome === 'alreadyUndone') {
      tally.alreadyUndone += 1;
      log.info(
        'Auto-post undo found a tagged transaction with nothing to reverse — finished it without posting',
        { companyId, runId, txId },
        'auto-post-undo',
      );
    } else {
      tally.skippedBy.failed += 1;
      log.error(
        outcome === 'reReversed'
          ? 'Auto-post undo skipped a transaction whose provisional journal reversal was itself reversed — the posting stands; run stays open'
          : 'Auto-post undo skipped a transaction marked posted with nothing linked to reverse — run stays open',
        { companyId, runId, txId, status: ctx.status },
        'auto-post-undo',
      );
    }
  } catch (err) {
    // The savepoint has rolled this row back alone — including
    // `reverseReconciledTransaction`'s bank-line lock, which it takes on the
    // enclosing transaction — so the request transaction is live and the
    // rows already reversed stand. Contention is skipped like any failure;
    // it is kept only to decide the answer below. Every lock timeout is contention (D8 round 11): the bank
    // reversal's flow budget refuses a held bill or invoice after 5 s, and that row is not "failed".
    if (isVoidCreditRefusal(err)) {
      if (!final) return 'creditRefused';
      tally.skippedBy.creditCeiling += 1;
      log.warn('Auto-post undo refused a transaction: voiding its payment would leave the supplier owing the company '
        + '(a refund already returned that cash) — run stays open', { companyId, runId, txId }, 'auto-post-undo');
    } else if (isRetryableContention(err) || isHeldRowError(err)) {
      tally.contention ??= err;
      tally.skippedBy.contended += 1;
      log.info('Auto-post undo skipped a contended transaction', { companyId, runId, txId }, 'auto-post-undo');
    } else {
      tally.skippedBy.failed += 1;
      log.error(
        'Auto-post undo failed for transaction — run stays open; manual reversal required for this tx',
        { companyId, runId, txId, error: err instanceof Error ? err.message : String(err) },
        'auto-post-undo',
      );
    }
  }
  return 'counted';
}
