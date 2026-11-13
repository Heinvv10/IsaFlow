/**
 * reallocate_bank_transaction (bankReallocationService): what a RECONCILED statement line must be for its
 * allocation to be re-pointed without reopening its reconciliation, and the plan that follows.
 *
 * The bank side must not move: the new journal carries the same bank leg (account, amount) on the SAME date as the
 * one it replaces, and the old journal's contra is dated on that date too, so the bank GL balance as at every date —
 * the figure a completed reconciliation signed off — is unchanged. Anything that cannot keep that is refused here,
 * from facts read under the line's lock (`loadReallocationFacts`), before any write. `planReallocation` is pure.
 *
 * v1 handles a line ALLOCATED (allocate_bank_transaction / the screen / a rule) to a standing journal of its own: no
 * transfer, split, provisional, payment batch, reversal history or second bank line. Matched lines (cash matched to an
 * existing journal) are refused: reversing that journal is not undoing this line's allocation.
 */
import type { DbRow } from '@/lib/neon';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';
import { isBankSubtype } from '../gl/accountSubtypes';
import { reconciliationLockOf, type LineLock } from './reconciledCash';
import { SPLIT_ALLOCATION_NAME } from './splitJournalDocuments';
import { isControlSubtype, planAllocationDimensions } from './bankAllocationDimensions';
import type { AutoApplyMode } from '../shared/autoAllocateStrategy';
import type { LineChain } from './bankChainLineReversal';

/** Raised before any write (the service's refusals) or inside its savepoint (the re-checks): always caller-facing. */
export class BankReallocationRefusal extends Error {
  readonly code = 'REALLOCATION_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'BankReallocationRefusal';
  }
}

export type ReallocationTarget =
  | { kind: 'account'; glAccountId: string }
  | { kind: 'supplier'; supplierId: string }
  | { kind: 'customer'; customerId: string };

export interface OldJournalLine {
  lineId: string; glAccountId: string; subtype: string | null; debit: number; credit: number;
  vatType: string | null; cc1Id: string | null; cc2Id: string | null; buId: string | null;
}

export interface ReallocationFacts {
  txId: string;
  line: {
    status: string; reconciliationId: string | null; allocationType: string | null; allocatedEntityName: string | null;
    provisionalJeId: string | null; counterpartyAccountId: string | null; transferJournalEntryId: string | null;
    matchedLineId: string | null; bankAccountId: string; transactionDate: string; amount: number;
  };
  lock: LineLock;
  chain: LineChain | null;
  /** Every statement line whose cash the journal's chain carries (matched or provisional), this one included. */
  chainCashLineIds: string[];
  /** peekReversalTarget of the chain root: the root itself while it stands with no reversal history. */
  reversalTarget: string | null;
  journal: { id: string; entryDate: string; lines: OldJournalLine[] } | null;
  /**
   * The old journal's live payments / receipts: their contacts, whether one is a payment batch, and (positive documents
   * only — a refund is never applied) how much of them is applied and how much is still on account.
   */
  documents: { supplierIds: string[]; customerIds: string[]; batch: boolean; applied: number; unapplied: number };
  /** The bank account's (card's) default dimensions — what allocate stamps on a contra line that names none. */
  bankDefaults: DimensionIds;
  /** A supplier / customer target: how many open documents FIFO could settle (bankReallocationLocks.openDocumentsOf). */
  targetOpenDocuments: number;
  /** The target GL account (account targets only); null when it is not this company's. */
  targetAccount: { subtype: string | null } | null;
}

export interface ReallocationRequest {
  expectedJournalEntryId: string; vatType?: string; dims?: DimensionIds;
  /** Supplier / customer targets: 'fifo' (default) applies the new document, 'none' leaves it on account. */
  autoApply?: AutoApplyMode;
}

export type ReallocationPlan =
  | { kind: 'nothing_changed'; reconciliationId: string; journalId: string; entryDate: string; bankLeg: OldJournalLine }
  | { kind: 'reallocate'; reconciliationId: string; journalId: string; entryDate: string; bankLeg: OldJournalLine };

const refuse = (m: string): never => { throw new BankReallocationRefusal(m); };
const UNRECONCILED = 'This bank line is not reconciled, so there is no completed reconciliation to keep: undo it with '
  + 'reverse_bank_allocation, then allocate it again with allocate_bank_transaction.';

function refuseUnlessCompleted(f: ReallocationFacts): void {
  const { lock, line } = f;
  if (lock?.kind === 'sage') {
    refuse('This bank line was reconciled in the Sage import (no reconciliation in this app holds it), so it cannot '
      + 'be reallocated here. Correct it with a journal, or contact support.');
  }
  if (lock?.kind === 'anomaly') {
    refuse("This bank line is marked reconciled on a reconciliation that isn't completed. That shouldn't happen, so "
      + 'contact support.');
  }
  if (lock?.kind === 'session') {
    refuse('This bank line is in an in-progress bank reconciliation. Reallocation keeps a COMPLETED reconciliation; '
      + 'here, Unmatch it on the reconciliation screen (or cancel the session), then reverse_bank_allocation and '
      + 'allocate_bank_transaction.');
  }
  if (line.status === 'allocated' || line.status === 'matched') refuse(UNRECONCILED);
  if (lock?.kind !== 'completed' || line.status !== 'reconciled' || !line.reconciliationId) {
    refuse(`This bank line is ${line.status}, not reconciled — there is nothing to reallocate. `
      + 'allocate_bank_transaction allocates an unallocated line.');
  }
}

function refuseV1Shapes(f: ReallocationFacts): void {
  const { line } = f;
  if (line.allocationType === 'transfer' || line.counterpartyAccountId || line.transferJournalEntryId) {
    refuse('This bank line is a transfer between bank accounts; reallocating a transfer is not supported. Reopen the '
      + 'reconciliation and reverse it instead.');
  }
  if (f.chainCashLineIds.some((id) => id !== f.txId)) {
    refuse('This journal carries more than one bank line (a transfer in all but name); it cannot be reallocated '
      + 'from one of them. Reopen the reconciliation and reverse it instead.');
  }
  if (line.allocatedEntityName === SPLIT_ALLOCATION_NAME) {
    refuse('This bank line is a split allocation; reallocating a split is not supported yet. Reopen the '
      + 'reconciliation, reverse it and split it again.');
  }
  if (line.provisionalJeId) refuse('This bank line is tied to a provisional journal; it cannot be reallocated.');
  if (f.documents.batch) {
    refuse('This bank line pays a supplier payment batch; reverse the batch (Batch Payments page) instead.');
  }
  if (!line.allocationType) {
    refuse('This bank line is matched to an existing journal, not allocated by it; reallocating it would reverse '
      + 'that journal. Reopen the reconciliation and Unmatch it instead.');
  }
}

/**
 * The same contact is the same allocation only when the new document would end where the old one stands: 'fifo'
 * over a document with nothing left on account (or with nothing open for FIFO to settle), 'none' over one with
 * nothing applied. Otherwise the reallocation re-applies (or un-applies) the cash, which is a real change.
 */
function sameContactOutcome(f: ReallocationFacts, req: ReallocationRequest): boolean {
  const cents = (n: number) => Math.round(n * 100);
  if ((req.autoApply ?? 'fifo') === 'none') return cents(f.documents.applied) === 0;
  return cents(f.documents.unapplied) === 0 || f.targetOpenDocuments === 0;
}

/**
 * The dimensions allocate would stamp on the contra line: none on a control account; otherwise what the caller named,
 * with the bank card's defaults filling the rest (bankAllocationDimensions.planAllocationDimensions). Null when allocate
 * would refuse the request (dimensions named on a control account), which is then not "the same".
 */
function stampedDims(f: ReallocationFacts, explicit: DimensionIds): DimensionIds | null {
  const control = isControlSubtype(f.targetAccount?.subtype ?? null);
  const named = Boolean(explicit.cc1Id || explicit.cc2Id || explicit.buId);
  if (control) return named ? null : {};
  return planAllocationDimensions({ settlement: false, contraIsControl: false, explicit, bankDefaults: f.bankDefaults });
}

/** Is the new target the one the line is on now? Then nothing is written. */
function sameTarget(f: ReallocationFacts, bankLegId: string, target: ReallocationTarget, req: ReallocationRequest): boolean {
  const type = f.line.allocationType;
  if (target.kind === 'supplier') {
    return type === 'supplier' && f.documents.supplierIds.includes(target.supplierId) && sameContactOutcome(f, req);
  }
  if (target.kind === 'customer') {
    return type === 'customer' && f.documents.customerIds.includes(target.customerId) && sameContactOutcome(f, req);
  }
  if (type !== 'account') return false;
  const contra = (f.journal?.lines ?? []).filter((l) => l.lineId !== bankLegId && l.glAccountId === target.glAccountId);
  if (contra.length !== 1) return false;
  const old = contra[0]!;
  const vat = (v: string | null | undefined) => (v === 'standard' || v === 'zero_rated' || v === 'exempt' ? v : 'none');
  if (vat(old.vatType) !== vat(req.vatType)) return false;
  const d = stampedDims(f, req.dims ?? {});
  if (!d) return false;
  return (d.cc1Id ?? null) === old.cc1Id && (d.cc2Id ?? null) === old.cc2Id && (d.buId ?? null) === old.buId;
}

/** The plan, or the refusal. Pure: every fact was read under the line's lock. */
export function planReallocation(f: ReallocationFacts, target: ReallocationTarget, req: ReallocationRequest): ReallocationPlan {
  refuseUnlessCompleted(f);
  const { chain, journal } = f;
  if (!chain || !journal || !f.line.matchedLineId) {
    return refuse('This bank line has no journal behind it, so there is nothing to reallocate. Contact support.');
  }
  if (chain.journalId !== req.expectedJournalEntryId) {
    refuse(`expected_journal_entry_id does not match: this bank line is reconciled to journal ${chain.journalId} now. `
      + 'Re-read the line and send that id.');
  }
  if (chain.rootId !== chain.journalId || f.reversalTarget !== chain.journalId) {
    refuse('This bank line\'s journal has reversal history; reallocating it is not supported. Reopen the '
      + 'reconciliation and reverse it instead.');
  }
  refuseV1Shapes(f);
  if (journal.entryDate !== f.line.transactionDate) {
    refuse(`This bank line's journal is dated ${journal.entryDate} but the statement line ${f.line.transactionDate}; `
      + 'the new allocation could not keep the journal\'s date. Reopen the reconciliation and reverse it instead.');
  }
  if (target.kind === 'account') {
    const account = f.targetAccount;
    if (!account) return refuse('Not found');
    if (target.glAccountId === f.line.bankAccountId || isBankSubtype(account.subtype)) {
      refuse('The target is a bank account (a transfer); reallocating to a bank account is not supported.');
    }
  }
  const bankLeg = journal.lines.find((l) => l.lineId === f.line.matchedLineId);
  if (!bankLeg || bankLeg.glAccountId !== f.line.bankAccountId) {
    return refuse('This bank line\'s journal line is not on its bank account; it cannot be reallocated. Contact support.');
  }
  const reconciliationId = f.line.reconciliationId;
  if (!reconciliationId) return refuse(UNRECONCILED); // refuseUnlessCompleted already demands one
  const base = { reconciliationId, journalId: journal.id, entryDate: journal.entryDate, bankLeg };
  return sameTarget(f, bankLeg.lineId, target, req) ? { kind: 'nothing_changed', ...base } : { kind: 'reallocate', ...base };
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

/**
 * allocateTransaction's `opts.reallocation` gate, on ITS locked row: the line must still be reconciled on exactly the
 * reconciliation the caller named, and that reconciliation completed. Only then may the D12 refusal and the
 * 'imported' requirement be set aside — for this line, by this caller.
 */
export async function assertReallocatableRow(
  companyId: string, tx: DbRow, kept: { reconciliationId: string },
): Promise<void> {
  if (tx.status !== 'reconciled' || str(tx.reconciliation_id) !== kept.reconciliationId) {
    refuse('This bank line is no longer reconciled on the reconciliation being kept — re-read it and retry.');
  }
  const lock = await reconciliationLockOf(companyId, tx);
  if (lock?.kind !== 'completed') {
    refuse('This bank line\'s reconciliation is no longer completed — re-read it and retry.');
  }
}
