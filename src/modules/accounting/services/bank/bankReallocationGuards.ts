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
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import type { DimensionIds } from '../gl/dimensions/dimensionTypes';
import { isBankSubtype } from '../gl/accountSubtypes';
import { reconciliationLockOf, type LineLock } from './reconciledCash';
import { findChainCashLines } from './chainBankLines';
import { peekReversalTarget } from './reversalDatePostable';
import { SPLIT_ALLOCATION_NAME } from './splitJournalDocuments';
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
  documents: { supplierIds: string[]; customerIds: string[]; batch: boolean };
  /** The target GL account (account targets only); null when it is not this company's. */
  targetAccount: { subtype: string | null } | null;
}

export interface ReallocationRequest { expectedJournalEntryId: string; vatType?: string; dims?: DimensionIds }

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

/** Is the new target the one the line is on now? Then nothing is written. */
function sameTarget(f: ReallocationFacts, bankLegId: string, target: ReallocationTarget, req: ReallocationRequest): boolean {
  const type = f.line.allocationType;
  if (target.kind === 'supplier') return type === 'supplier' && f.documents.supplierIds.includes(target.supplierId);
  if (target.kind === 'customer') return type === 'customer' && f.documents.customerIds.includes(target.customerId);
  if (type !== 'account') return false;
  const contra = (f.journal?.lines ?? []).filter((l) => l.lineId !== bankLegId && l.glAccountId === target.glAccountId);
  if (contra.length !== 1) return false;
  const old = contra[0]!;
  const vat = (v: string | null | undefined) => (v === 'standard' || v === 'zero_rated' || v === 'exempt' ? v : 'none');
  if (vat(old.vatType) !== vat(req.vatType)) return false;
  const d = req.dims;
  if (!d) return true;
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
    if (!f.targetAccount) refuse('Not found');
    if (target.glAccountId === f.line.bankAccountId || isBankSubtype(f.targetAccount!.subtype)) {
      refuse('The target is a bank account (a transfer); reallocating to a bank account is not supported.');
    }
  }
  const bankLeg = journal.lines.find((l) => l.lineId === f.line.matchedLineId);
  if (!bankLeg || bankLeg.glAccountId !== f.line.bankAccountId) {
    return refuse('This bank line\'s journal line is not on its bank account; it cannot be reallocated. Contact support.');
  }
  const base = { reconciliationId: f.line.reconciliationId!, journalId: journal.id, entryDate: journal.entryDate, bankLeg };
  return sameTarget(f, bankLeg.lineId, target, req) ? { kind: 'nothing_changed', ...base } : { kind: 'reallocate', ...base };
}

const str = (v: unknown): string | null => (v == null ? null : String(v));

/** Every fact `planReallocation` decides on. Reads only; the line (`tx`) and its chain's lines are already locked. */
export async function loadReallocationFacts(
  companyId: string, tx: DbRow, chain: LineChain | null, target: ReallocationTarget,
): Promise<ReallocationFacts> {
  const txId = String(tx.id);
  const root = chain?.rootId ?? null;
  const journalId = chain?.journalId ?? null;
  const [je] = journalId ? (await sql`
    SELECT entry_date FROM gl_journal_entries
    WHERE id = ${journalId}::UUID AND company_id = ${companyId}::UUID AND status = 'posted'`) as DbRow[]
    : [];
  const lines = je ? (await sql`
    SELECT jl.id::TEXT AS id, jl.gl_account_id::TEXT AS account, a.account_subtype, jl.debit::float8 AS debit,
           jl.credit::float8 AS credit, jl.vat_type, jl.cc1_id::TEXT AS cc1, jl.cc2_id::TEXT AS cc2, jl.bu_id::TEXT AS bu
    FROM gl_journal_lines jl
    LEFT JOIN gl_accounts a ON a.id = jl.gl_account_id AND a.company_id = jl.company_id
    WHERE jl.journal_entry_id = ${journalId}::UUID AND jl.company_id = ${companyId}::UUID
    ORDER BY jl.id`) as DbRow[] : [];
  const docs = root ? (await sql`
    SELECT 'supplier' AS kind, supplier_id::TEXT AS contact FROM supplier_payments
      WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${root}::UUID AND status <> 'cancelled'
    UNION ALL
    SELECT 'customer', client_id::TEXT FROM customer_payments
      WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${root}::UUID AND status <> 'cancelled'
    UNION ALL
    SELECT 'batch', NULL FROM supplier_payment_batches
      WHERE company_id = ${companyId}::UUID AND gl_journal_entry_id = ${root}::UUID`) as DbRow[] : [];
  const [acct] = target.kind === 'account' ? (await sql`
    SELECT account_subtype FROM gl_accounts WHERE id = ${target.glAccountId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[]
    : [];
  return {
    txId,
    line: {
      status: String(tx.status ?? ''), reconciliationId: str(tx.reconciliation_id), allocationType: str(tx.allocation_type),
      allocatedEntityName: str(tx.allocated_entity_name), provisionalJeId: str(tx.provisional_je_id),
      counterpartyAccountId: str(tx.counterparty_account_id), transferJournalEntryId: str(tx.transfer_journal_entry_id),
      matchedLineId: str(tx.matched_journal_line_id), bankAccountId: String(tx.bank_account_id),
      transactionDate: fmtDate(tx.transaction_date as string | Date), amount: Number(tx.amount),
    },
    lock: await reconciliationLockOf(companyId, tx),
    chain,
    chainCashLineIds: journalId ? await findChainCashLines(companyId, journalId) : [],
    reversalTarget: root ? await peekReversalTarget(companyId, root) : null,
    journal: je && journalId ? {
      id: journalId, entryDate: fmtDate(je.entry_date as string | Date),
      lines: lines.map((l) => ({
        lineId: String(l.id), glAccountId: String(l.account), subtype: str(l.account_subtype), debit: Number(l.debit),
        credit: Number(l.credit), vatType: str(l.vat_type), cc1Id: str(l.cc1), cc2Id: str(l.cc2), buId: str(l.bu),
      })),
    } : null,
    documents: {
      supplierIds: docs.filter((d) => d.kind === 'supplier').map((d) => String(d.contact)),
      customerIds: docs.filter((d) => d.kind === 'customer').map((d) => String(d.contact)),
      batch: docs.some((d) => d.kind === 'batch'),
    },
    targetAccount: target.kind === 'account' ? (acct ? { subtype: str(acct.account_subtype) } : null) : null,
  };
}

/**
 * allocateTransaction's `opts.reallocation` gate, on ITS locked row: the line must still be reconciled on exactly the
 * reconciliation the caller named, and that reconciliation completed. Only then may the D12 refusal and the
 * 'imported' requirement be set aside — for this line, by this caller.
 */
export async function assertReallocatableRow(
  companyId: string, tx: DbRow, reallocation: { reconciliationId: string },
): Promise<void> {
  if (tx.status !== 'reconciled' || str(tx.reconciliation_id) !== reallocation.reconciliationId) {
    refuse('This bank line is no longer reconciled on the reconciliation being kept — re-read it and retry.');
  }
  const lock = await reconciliationLockOf(companyId, tx);
  if (lock?.kind !== 'completed') {
    refuse('This bank line\'s reconciliation is no longer completed — re-read it and retry.');
  }
}
