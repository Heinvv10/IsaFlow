/**
 * D10 O1 / O1b / O3: the bank reversal (`reverseReconciledTransaction`) of a statement line whose journal belongs to a
 * DOCUMENT's reversal chain — a supplier payment, a customer receipt or a payment batch.
 *
 * The document carries its chain's ROOT O (`gl_journal_entry_id`), while a line can be matched to O, to a middle
 * reversal or to the head (after O <- R1 <- R2). The reversal used to read everything off the LINE's journal: the
 * document was not found (a head line at k even posted the contra and left the payment live, its bills paid), the
 * target was decided by the chain below that journal (a k-odd head line re-reversed the head and put the payment back;
 * a middle line reversed nothing while the chain stood), a batch was never reversed (its members carry no journal),
 * and every other line of the chain stayed 'matched' against cash the reversal took out. Now, as the HTTP void does
 * (ap/paymentJournalReversal): resolve O (shared/journalChainHead.findJournalChainRoot), lock EVERY statement line of
 * O's chain in id order with this one, refuse reconciled cash on any of them, unwind the document (payment ->
 * invoices) or run the batch reversal (batch -> members -> bills), then `lockJournalAndUnmatch` (journals locked, the
 * head and the chain's lines re-checked, the matched lines freed) and reverse the head iff the chain stands — one
 * contra or none. Lock order: bank lines -> document -> bills / invoices -> journals (D8).
 *
 * A journal that no document carries (a plain or transfer journal) is not handled here: only its target moves to O's
 * chain (bankAllocationService); its other lines — a transfer's second bank leg — are out of D10's scope.
 */
import { sql, withSavepoint } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PostingActorOpts } from '../gl/journalEntryMeta';
import { reverseJournalEntry } from '../gl/journalEntryPostingService';
import { brokenChainMessage, findJournalChainRoot } from '../shared/journalChainHead';
import { lockJournalAndUnmatch, type BankLeg } from '../ap/paymentJournalReversal';
import { reverseBatchWithLeg } from '../ap/batchPaymentReversal';
import { BankAllocationRefusal } from './bankAllocationRefusal';
import { unwindBankAllocationApplication, type BankAllocationUnwindResult } from './bankAllocationUnwind';
import { findChainBankLines } from './chainBankLines';
import { lockBankTransactionsInIdOrder } from './bankTxLock';
import { reconciliationLockOf, refuseLockedCash } from './reconciledCash';
import { assertReversalDatePostable, entryDateOf, peekReversalTarget } from './reversalDatePostable';

type Opts = PostingActorOpts & { reversalDate?: string };

/** The document a chain root belongs to; a batch only while it is processed (a reversed one has nothing to undo). */
export type ChainDocument = { label: string; batchId: string | null };

export interface LineChain { lineId: string; rootId: string; doc: ChainDocument | null }

/** YYYY-MM-DD of a pg date (Date or string). */
export function isoDay(v: unknown): string | null {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

async function chainDocumentOf(companyId: string, rootId: string): Promise<ChainDocument | null> {
  const [doc] = (await sql`
    SELECT 'Batch ' || batch_number AS label, id::TEXT AS batch_id, status = 'processed' AS live
      FROM supplier_payment_batches WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${rootId}::UUID
    UNION ALL
    SELECT 'Payment ' || payment_number, NULL, true
      FROM supplier_payments WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${rootId}::UUID
    UNION ALL
    SELECT 'Receipt ' || payment_number, NULL, true
      FROM customer_payments WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${rootId}::UUID
    LIMIT 1
  `) as DbRow[];
  if (!doc) return null;
  return { label: String(doc.label), batchId: doc.batch_id && doc.live === true ? String(doc.batch_id) : null };
}

/** UNLOCKED, before any lock: the line's journal, its chain root and the document on it. Null for an unmatched line. */
export async function peekLineChain(companyId: string, bankTxId: string): Promise<LineChain | null> {
  const [row] = (await sql`
    SELECT bt.matched_journal_line_id::TEXT AS line_id, jl.journal_entry_id::TEXT AS je
    FROM bank_transactions bt
    JOIN gl_journal_lines jl ON jl.id = bt.matched_journal_line_id AND jl.company_id = bt.company_id
    WHERE bt.id = ${bankTxId}::UUID AND bt.company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!row) return null;
  const rootId = await findJournalChainRoot(companyId, String(row.je));
  if (!rootId) throw new BankAllocationRefusal(brokenChainMessage(String(row.je), { unreversed: 0, cyclic: true }));
  return { lineId: String(row.line_id), rootId, doc: await chainDocumentOf(companyId, rootId) };
}

/** FIRST, before the line's own lock: every statement line of the root's chain, this one included, in id order. */
export async function lockChainLines(companyId: string, chain: LineChain): Promise<DbRow[]> {
  return lockBankTransactionsInIdOrder(companyId, await findChainBankLines(companyId, chain.rootId));
}

/**
 * The reversal itself, `tx` (the line) locked, its own refusals passed and still matched as peeked, `lines` the
 * chain's lines locked by `lockChainLines` (`tx` among them). Every write in one savepoint, so a refusal from the batch reversal or the re-check changes nothing.
 */
export async function reverseDocumentChainLine(
  companyId: string, tx: DbRow, chain: LineChain & { doc: ChainDocument }, lines: DbRow[], userId: string, opts?: Opts,
): Promise<BankAllocationUnwindResult> {
  const txId = String(tx.id); // the caller has checked it is still matched to the line it peeked
  const others = lines.filter((l) => String(l.id) !== txId);
  for (const l of others) refuseLockedCash(await reconciliationLockOf(companyId, l), 'Another bank line of this journal chain');
  if (others.some((l) => l.status === 'allocated')) {
    throw new BankAllocationRefusal(`${chain.doc.label}'s journal chain is claimed by more than one allocated bank line — `
      + 'it cannot be reversed from one of them. Contact support.');
  }
  const reverseId = await peekReversalTarget(companyId, chain.rootId); // the head while the chain stands, else null
  if (reverseId) await assertReversalDatePostable(companyId, reverseId, opts?.reversalDate);
  const originalEntryDate = isoDay(await entryDateOf(companyId, reverseId ?? chain.rootId));
  const leg: BankLeg = {
    alreadyReversed: reverseId === null, reverseId: reverseId ?? chain.rootId,
    bankLineIds: others.map((l) => String(l.id)), seenLineIds: lines.map((l) => String(l.id)),
    allocatedLineIds: tx.status === 'allocated' ? [txId] : [],
  };
  return withSavepoint('bank_reverse_chain_line', async () => {
    let result: BankAllocationUnwindResult;
    let reversal: Awaited<ReturnType<typeof reverseJournalEntry>> | null;
    if (chain.doc.batchId) {
      const b = await reverseBatchWithLeg(companyId, chain.doc.batchId, userId, chain.rootId, leg, opts);
      result = { invoicesReopened: b.billsReopened, amountUnapplied: b.amountUnapplied, paymentsCancelled: b.membersCancelled };
      reversal = b.reversal;
    } else {
      result = await unwindBankAllocationApplication(companyId, chain.rootId); // payment -> invoices, before the journal
      await lockJournalAndUnmatch(companyId, chain.rootId, leg, chain.doc.label);
      reversal = leg.alreadyReversed ? null : await reverseJournalEntry(companyId, leg.reverseId, userId, opts);
    }
    await resetBankLine(companyId, txId, false);
    return {
      ...result, vatLockRoll: reversal?.vatLockRoll ?? null,
      originalEntryDate, reversalEntryDate: reversal ? isoDay(reversal.entryDate) : null,
    };
  });
}

/** The line back to 'imported', out of its allocation batch; `clearProvisional` also drops a dead provisional link. */
export async function resetBankLine(companyId: string, bankTxId: string, clearProvisional: boolean): Promise<void> {
  await sql`
    UPDATE bank_transactions
    SET status = 'imported', matched_journal_line_id = NULL, reconciliation_id = NULL,
        linked_po_id = NULL, allocation_type = NULL, allocated_entity_name = NULL,
        allocation_rule_id = NULL, allocation_rule_name = NULL,
        -- Reversing one line takes it OUT of its batch: the batch no longer
        -- owns a journal here, and a later re-allocation must not be swept
        -- up by reverse_bank_allocation_batch.
        allocation_batch_id = NULL,
        provisional_je_id = CASE WHEN ${clearProvisional} THEN NULL ELSE provisional_je_id END,
        updated_at = NOW()
    WHERE id = ${bankTxId}::UUID AND company_id = ${companyId}::UUID`;
}
