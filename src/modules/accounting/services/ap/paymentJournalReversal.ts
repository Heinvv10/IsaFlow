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
import { lockBankTransactionForUpdate } from '../bank/bankTxLock';
import { unmatchTransaction } from '../bank/bankTxStatusMutations';
import { resolveReversalDate } from '../gl/journalEntryReversalDate';
import { getPeriodStatusForDate } from '../gl/periodStatusService';
import { SupplierPaymentRefusal } from './supplierPaymentRefusal';

export interface BankLeg {
  /** The journal already carries a reversal claim; the caller decides what that means. */
  alreadyReversed: boolean;
  /** Bank lines MATCHED to the journal, locked, to unmatch once the writes begin. */
  bankLineIds: string[];
  /** Every bank line seen on the journal, matched or allocated — the re-check's baseline. */
  seenLineIds: string[];
  /** Lines ALLOCATED to the journal: a bank allocation posted it, so the undo is
   *  `reverseReconciledTransaction`, not an unmatch. */
  allocatedLineIds: string[];
}

/**
 * THE rule for "this cash is reconciled": the bank line is on a bank
 * reconciliation — status 'reconciled' (reachable only by completing one) or a
 * `reconciliation_id` naming a COMPLETED `bank_reconciliations` row. A line in
 * an IN-PROGRESS session is refused too, with its own remedy: unmatching it
 * would change that session's figures underneath the person reconciling. It is
 * NOT the payment's own status: on a supplier payment 'reconciled' means fully
 * applied to its bills.
 */
async function assertNotReconciled(companyId: string, row: DbRow, label: string): Promise<void> {
  let recStatus: string | null = null;
  if (row.reconciliation_id) {
    const rec = (await sql`
      SELECT status FROM bank_reconciliations
      WHERE id = ${String(row.reconciliation_id)}::UUID AND company_id = ${companyId}::UUID
    `) as DbRow[];
    recStatus = rec[0] ? String(rec[0].status) : null;
  }
  if (row.status === 'reconciled' || recStatus === 'completed') {
    throw new SupplierPaymentRefusal(`${label} is on a completed bank reconciliation — reverse it there `
      + 'before voiding or reversing the payment.');
  }
  if (row.reconciliation_id) {
    throw new SupplierPaymentRefusal(`${label}'s bank line is in an open bank reconciliation session — `
      + 'remove it from that session (or cancel the session) first.');
  }
}

async function matchedBankLines(companyId: string, journalId: string): Promise<string[]> {
  const rows = (await sql`
    SELECT bt.id FROM bank_transactions bt
    JOIN gl_journal_lines l ON l.id = bt.matched_journal_line_id
    WHERE l.journal_entry_id = ${journalId}::UUID AND bt.company_id = ${companyId}::UUID
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
  if (je[0].reversed_at) return { alreadyReversed: true, bankLineIds: [], seenLineIds: [], allocatedLineIds: [] };
  if (je[0].status !== 'posted') {
    throw new SupplierPaymentRefusal(`${label}'s journal is ${String(je[0].status)}, not posted — there is nothing to reverse.`);
  }
  // The date exactly as `reverseJournalEntry` will choose it: the original's if
  // that period is open, otherwise today. Closed or missing → 400, pre-write.
  const reversalDate = await resolveReversalDate(companyId, fmtDate(je[0].entry_date), undefined);
  if ((await getPeriodStatusForDate(companyId, reversalDate)) !== 'open') {
    throw new SupplierPaymentRefusal(`The reversal would be dated ${reversalDate}, which is not in an open `
      + 'fiscal period — re-open it or create the fiscal year first.');
  }

  const ids = await matchedBankLines(companyId, journalId);
  const toUnmatch: string[] = [];
  const allocated: string[] = [];
  for (const id of ids) {
    const row = await lockBankTransactionForUpdate(companyId, id);
    if (!row) continue;
    await assertNotReconciled(companyId, row, label);
    // An ALLOCATED line posted this journal itself (a bank allocation): undoing
    // it is `reverseReconciledTransaction`'s job — unwind, contra, reset the line.
    if (row.status === 'allocated') allocated.push(id);
    else toUnmatch.push(id);
  }
  return { alreadyReversed: false, bankLineIds: toUnmatch, seenLineIds: ids, allocatedLineIds: allocated };
}

/**
 * LAST, after the document and bills: lock the journal, confirm no bank line
 * was matched to it since `lockBankLegOf` looked, and unmatch the locked ones.
 * A new match is contention — retryable, raised inside the caller's savepoint.
 */
export async function lockJournalAndUnmatch(
  companyId: string, journalId: string, leg: BankLeg, label: string,
): Promise<void> {
  await sql`
    SELECT id FROM gl_journal_entries
    WHERE id = ${journalId}::UUID AND company_id = ${companyId}::UUID
    FOR UPDATE
  `;
  const now = await matchedBankLines(companyId, journalId);
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
