/**
 * Reversing a PAYMENT journal — shared by single-payment void and batch
 * reversal so the two cannot drift.
 *
 * A payment journal IS the bank leg: its CR Bank line is what a bank statement
 * line gets matched to. So reversing it must (a) refuse when that bank line is
 * reconciled, (b) unmatch it otherwise, so the statement line is free to match
 * again instead of pointing at cash the GL no longer shows as paid, and (c)
 * know BEFORE the first write that the contra can post — single void used to
 * discover a closed period inside `reverseJournalEntry` and answer 500.
 *
 * LOCK ORDER is the canonical one (`bank/.claude.md`): bank line → payment /
 * batch → bills → journal. So the caller runs `lockBankLegOf` FIRST, from an
 * unlocked peek of the journal id (as `voidPaymentDocument` does), then locks
 * its document and bills, and calls `lockJournalAndUnmatch` last, just before
 * `reverseJournalEntry`. `matchTransaction` takes bank line → journal
 * (`FOR SHARE`); a match that lands on this journal between the peek and the
 * journal lock is caught there by the re-read and answered as contention
 * (retry): the caller's savepoint discards its writes, and the retry sees and
 * unmatches the new line. A match that waits on the journal lock finds it
 * reversed and is refused (`LINE_REVERSED`).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { lockBankTransactionsInIdOrder } from '../bank/bankTxLock';
import { unmatchTransaction } from '../bank/bankTxStatusMutations';
import { ReconciledCashError, reconciliationLockOf, refuseLockedCash } from '../bank/reconciledCash';
import { ReversalBeforeOriginalError, resolveReversalDate } from '../gl/journalEntryReversalDate';
import { loadJournalVatLines } from '../gl/journalVatLockGuard';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';
import { brokenChainMessage, findJournalChainHead, lockChainHead } from '../shared/journalChainHead';
import { withRowLockBudget } from '../core/rowLockBudget';
import { JournalReversalLockTimeoutError } from '../gl/journalEntryReversalClaim';

export interface BankLeg {
  /** The journal's reversal chain is out of the ledger; the caller decides what that means. */
  alreadyReversed: boolean;
  /**
   * The entry the void reverses: the journal itself, or — once it was reversed
   * and that reversal reversed (O <- R <- R2) — the chain HEAD that carries it
   * back in the ledger (D8, shared/journalChainHead).
   */
  reverseId: string;
  /** Bank lines MATCHED to the journal, locked, to unmatch once the writes begin. */
  bankLineIds: string[];
  /** Every bank line seen on the journal, matched or allocated — the re-check's baseline. */
  seenLineIds: string[];
  /** Lines ALLOCATED to the journal: a bank allocation posted it, so the undo is
   *  `reverseReconciledTransaction`, not an unmatch. */
  allocatedLineIds: string[];
}

/**
 * The shared reconciled-cash rule (`bank/reconciledCash.ts`, the same one bank
 * reverse applies): completed or Sage reconciliation, or an open session. The
 * payment's own status plays no part: on a supplier payment 'reconciled' means
 * fully applied.
 */
async function assertNotReconciled(companyId: string, row: DbRow, label: string): Promise<void> {
  const lock = await reconciliationLockOf(companyId, row);
  try {
    refuseLockedCash(lock, `${label}'s bank line`);
  } catch (err) {
    // Re-typed so the AP routes answer it 400 like every other refusal here.
    if (err instanceof ReconciledCashError) throw new SupplierPaymentRefusal(err.message);
    throw err;
  }
}

/** Bank lines matched to any of `journalIds` — the journal and, for a re-reversed one, its head. */
async function matchedBankLines(companyId: string, journalIds: string[]): Promise<string[]> {
  const rows = (await sql`
    SELECT bt.id FROM bank_transactions bt
    JOIN gl_journal_lines l ON l.id = bt.matched_journal_line_id
    WHERE l.journal_entry_id = ANY(${journalIds}::UUID[]) AND bt.company_id = ${companyId}::UUID
    ORDER BY bt.id
  `) as DbRow[];
  return rows.map((r) => String(r.id));
}

/**
 * FIRST, before the document lock: every pre-write refusal about the journal,
 * then a lock on each bank line matched to it. `label` names the document.
 */
export async function lockBankLegOf(companyId: string, journalId: string, label: string): Promise<BankLeg> {
  const je = (await sql`
    SELECT entry_date, reversed_at, status FROM gl_journal_entries
    WHERE id = ${journalId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!je[0]) throw new SupplierPaymentRefusal(`${label}'s journal was not found.`);
  // Stamped reversed: read the CHAIN, not the stamp. Out of the ledger, nothing
  // to reverse; reversed and re-reversed, the head is what stands (D8).
  let target = { id: journalId, entryDate: je[0].entry_date };
  if (je[0].reversed_at) {
    const chain = await findJournalChainHead(companyId, journalId);
    if (chain?.kind === 'broken') throw new SupplierPaymentRefusal(brokenChainMessage(journalId, chain));
    if (!chain || !chain.standing) {
      // Nothing to reverse, but its bank lines still matter (D8 round 6): a GL
      // reversal does not unmatch them, so a line matched to it would stay
      // 'matched' against cash the ledger no longer holds — and reconciled cash
      // must still refuse the void.
      const lines = await lockMatchedLines(companyId, [journalId], label);
      return { alreadyReversed: true, reverseId: journalId, ...lines };
    }
    const [head] = (await sql`
      SELECT entry_date FROM gl_journal_entries WHERE id = ${chain.id}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    target = { id: chain.id, entryDate: head!.entry_date };
  }
  if (je[0].status !== 'posted') {
    throw new SupplierPaymentRefusal(`${label}'s journal is ${String(je[0].status)}, not posted — there is nothing to reverse.`);
  }
  // The date exactly as `reverseJournalEntry` will choose it: the original's if
  // that period is open, otherwise today. Closed or missing → 400, pre-write.
  // With the lines: a VAT-carrying journal whose default date is in a locked
  // VAT period rolls forward here exactly as it will in reverseJournalEntry,
  // and refuses pre-write when nothing up to today can take it.
  let reversalDate: string;
  try {
    reversalDate = await resolveReversalDate(
      companyId, fmtDate(target.entryDate as string | Date), undefined, await loadJournalVatLines(companyId, target.id));
  } catch (err) {
    // R-012: the route answers only typed refusals with a 4xx; this one is too.
    if (err instanceof ReversalBeforeOriginalError) throw new SupplierPaymentRefusal(err.message);
    throw err;
  }
  if ((await getPeriodStatusForDate(companyId, reversalDate)) !== 'open') {
    throw new SupplierPaymentRefusal(`The reversal would be dated ${reversalDate}, which is not in an open `
      + 'fiscal period — re-open it or create the fiscal year first.');
  }

  const lines = await lockMatchedLines(companyId, [...new Set([journalId, target.id])], label);
  return { alreadyReversed: false, reverseId: target.id, ...lines };
}

/** Lock every bank line matched to `journalIds`, refuse reconciled cash, and sort them: unmatch vs allocated. */
async function lockMatchedLines(
  companyId: string, journalIds: string[], label: string,
): Promise<Pick<BankLeg, 'bankLineIds' | 'seenLineIds' | 'allocatedLineIds'>> {
  const ids = await matchedBankLines(companyId, journalIds);
  const toUnmatch: string[] = [];
  const allocated: string[] = [];
  // The one id order every flow takes bank lines in (D8 round 11, `bank/bankTxLock`).
  for (const row of await lockBankTransactionsInIdOrder(companyId, ids)) {
    const id = String(row.id);
    await assertNotReconciled(companyId, row, label);
    // An ALLOCATED line posted this journal itself (a bank allocation): undoing
    // it is `reverseReconciledTransaction`'s job — unwind, contra, reset the line.
    if (row.status === 'allocated') allocated.push(id);
    else toUnmatch.push(id);
  }
  return { bankLineIds: toUnmatch, seenLineIds: ids, allocatedLineIds: allocated };
}

/**
 * LAST, after the document and bills: lock the journal (and the head the void
 * reverses, when that is not the journal itself), confirm no bank line
 * was matched to it since `lockBankLegOf` looked, and unmatch the locked ones.
 * A new match is contention — retryable, raised inside the caller's savepoint.
 */
export async function lockJournalAndUnmatch(
  companyId: string, journalId: string, leg: BankLeg, label: string,
): Promise<void> {
  const journals = [...new Set([journalId, leg.reverseId])];
  // ORDER BY id: two requests locking the same two journals take them in one order. Bounded (D8 round 9).
  await withRowLockBudget(() => sql`
    SELECT id FROM gl_journal_entries
    WHERE id = ANY(${journals}::UUID[]) AND company_id = ${companyId}::UUID
    ORDER BY id
    FOR UPDATE
  `, () => new JournalReversalLockTimeoutError(journalId));
  // The head the leg named, re-read under lock (D8 round 6): lockBankLegOf walked
  // the chain unlocked, and a reversal landing since makes reverseId stale — or
  // flips the chain in or out. Contention, retryable, never an untyped
  // "already reversed" from reverseJournalEntry.
  const head = await lockChainHead(companyId, journalId, (m) => new SupplierPaymentRefusal(m));
  const standing = head?.standing === true;
  if (standing === leg.alreadyReversed || (standing && head!.id !== leg.reverseId)) {
    throw new SupplierPaymentRefusal(
      `${label}'s journal was reversed by another request while this was in progress — retry in a moment.`,
      { retryable: true },
    );
  }
  const now = await matchedBankLines(companyId, journals);
  if (now.some((id) => !leg.seenLineIds.includes(id))) {
    throw new SupplierPaymentRefusal(
      `A bank line was matched to ${label}'s journal while it was being reversed — retry in a moment.`,
      { retryable: true },
    );
  }
  for (const id of leg.bankLineIds) await unmatchTransaction(companyId, id);
}

/**
 * Single void's first act: from an UNLOCKED peek of the payment, lock the bank
 * leg of its journal, so the bank line is taken before the payment row. The
 * caller re-checks, under the payment lock, that the journal is still the one
 * peeked (`assertSameJournal`).
 */
export async function lockPaymentBankLeg(
  companyId: string, paymentId: string,
): Promise<{ journalId: string | null; leg: BankLeg | null }> {
  const rows = (await sql`
    SELECT payment_number, status, gl_journal_entry_id FROM supplier_payments
    WHERE id = ${paymentId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  const p = rows[0];
  if (!p || (p.status !== 'processed' && p.status !== 'reconciled') || !p.gl_journal_entry_id) {
    return { journalId: null, leg: null };
  }
  const journalId = String(p.gl_journal_entry_id);
  return { journalId, leg: await lockBankLegOf(companyId, journalId, `Payment ${String(p.payment_number)}`) };
}

/** The document moved between the peek and its lock (e.g. processed meanwhile): retry. */
export function assertSameJournal(peeked: string | null, locked: string | undefined): void {
  if ((locked ?? null) !== peeked) {
    throw new SupplierPaymentRefusal('This document changed while it was being reversed — retry in a moment.',
      { retryable: true });
  }
}

/**
 * A payment whose journal a bank ALLOCATION posted is undone the way MCP
 * `void_payment` undoes it (`voidPaymentDocument`, shape 1): through
 * `reverseReconciledTransaction`, which unwinds every payment hanging off that
 * journal (bills reopened, the payment cancelled), posts the one contra and
 * returns the bank line to `imported`. Answers false when there is no such line.
 * Two allocated lines on one journal are refused, as MCP refuses them: picking
 * one would leave the other allocated against a reversed journal.
 */
export async function voidViaBankAllocation(
  companyId: string, leg: BankLeg, userId: string, label: string,
): Promise<boolean> {
  if (leg.allocatedLineIds.length === 0) return false;
  if (leg.allocatedLineIds.length > 1 || leg.bankLineIds.length > 0) {
    throw new SupplierPaymentRefusal(`${label}'s journal is claimed by more than one bank line — `
      + 'reverse them from the bank screen.');
  }
  // Dynamic, as `voidPaymentDocument` imports the GL service: the bank module
  // reaches back into AP, and a static import here would close that cycle.
  const { reverseReconciledTransaction } = await import('../bank/bankAllocationService');
  await reverseReconciledTransaction(companyId, leg.allocatedLineIds[0]!, userId);
  return true;
}
