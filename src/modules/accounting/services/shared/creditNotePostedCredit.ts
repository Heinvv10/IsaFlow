/**
 * What a credit note's journal actually put on the control account — the most
 * of the note that may ever be APPLIED to documents.
 *
 * An application posts no journal: the note's own journal moved the receivable
 * (or payable) when it was approved, and applying only moves the subledger. So
 * every rand applied must already be in the ledger through that journal. Two
 * shapes break it, and the explicit apply paths used to accept both:
 *
 *   · the note's journal is gone — missing, never posted, or reversed — so
 *     nothing at all stands behind an application;
 *   · the journal moved the control account by LESS than `total_amount` (an
 *     imported note whose journal was rounded apart from its header, or a
 *     control leg on an account not typed receivable / payable).
 *
 * The movement is read the way the subledger reconciliation reads it
 * (`reconciliation/creditNoteRelief.ts`): a customer note CREDITS the
 * receivable, a supplier note DEBITS the payable, on accounts typed by subtype.
 * An approval posts its control leg through `getSystemAccount('receivable' |
 * 'payable')`, which resolves by that same subtype, so a note approved in
 * IsaFlow always reads its full total here.
 *
 * THE RULE is about INCREASES: a write may never take what the note has applied
 * above its posted credit. A decrease is always allowed, so a note already
 * applied past its posted credit (legacy) can be brought back down.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { JournalReversalLockTimeoutError } from '../gl/journalEntryReversalClaim';
import { findJournalChainHead, findJournalChainRoot, shareLockChainHeadOf } from './journalChainHead';
import { PAYABLE_SUBTYPES, RECEIVABLE_SUBTYPES } from '../gl/accountSubtypes';
import { round2 } from './autoAllocateStrategy';
import type { CreditNoteSide } from './creditNoteFifo';

/** A note whose applications the ledger does not (or no longer) carry. Safe to show the caller. */
export class CreditNotePostedCreditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CreditNotePostedCreditError';
  }
}

/**
 * The note's journal chain is held by another request (a reversal or a cancel). Same code and class as the
 * reversal claim's timeout, so every caller already answers it as retryable (REST 503 + Retry-After, MCP retry).
 */
export class CreditNoteJournalLockTimeoutError extends JournalReversalLockTimeoutError {
  constructor(entryId: string) {
    super(entryId);
    this.name = 'CreditNoteJournalLockTimeoutError';
    this.message = "The note's journal is locked by another request (a reversal or cancel) — retry in a moment.";
  }
}

/** Exact cents: R0.01 unbacked is the defect this exists to refuse. */
const HALF_CENT = 0.005;

type NoteRef = { gl_journal_entry_id?: unknown; credit_note_number?: unknown };

export interface NotePostedCredit {
  journalId: string;
  /** The note's net movement on the control account, in the note's direction (never below 0). */
  posted: number;
}

export const controlSubtypes = (side: CreditNoteSide): string[] =>
  [...(side === 'customer' ? RECEIVABLE_SUBTYPES : PAYABLE_SUBTYPES)];

/**
 * The note's live journal and what it put on the control account. Throws when
 * the note has no posted, unreversed journal: nothing it applies is backed.
 *
 * Liveness is the note journal's REVERSAL CHAIN, not its own `reversed_at`: after
 * O <- R <- R2 the ledger carries O's credit again through R2 while O stays
 * stamped (`shared/journalChainHead`), so the question is whether the chain is
 * STANDING. Its head is share-locked (`shareLockChainHeadOf`, the lock a
 * reversal's claim conflicts with), so a reversal in flight is waited for
 * (bounded; `CreditNoteJournalLockTimeoutError`, retryable) and then seen, and
 * none can commit before the application does. The amount is O's own control
 * movement — what the standing chain carries.
 */
export async function readNotePostedCredit(
  companyId: string,
  note: NoteRef,
  side: CreditNoteSide,
): Promise<NotePostedCredit> {
  const label = `Credit note ${String(note.credit_note_number ?? '')}`.trim();
  const journalId = note.gl_journal_entry_id ? String(note.gl_journal_entry_id) : null;
  if (!journalId) {
    throw new CreditNotePostedCreditError(
      `${label} has no posted journal behind it, so no credit is in the ledger to apply. Reconcile it by hand.`,
    );
  }
  let head: { id: string; standing: boolean } | null;
  try {
    head = await shareLockChainHeadOf(companyId, journalId, (m) => new CreditNotePostedCreditError(`${label}: ${m}`));
  } catch (err) {
    if (err instanceof JournalReversalLockTimeoutError) throw new CreditNoteJournalLockTimeoutError(journalId);
    throw err;
  }
  if (!head) {
    throw new CreditNotePostedCreditError(`${label}'s journal is not posted, so no credit is in the ledger to apply.`);
  }
  if (!head.standing) {
    throw new CreditNotePostedCreditError(
      `${label}'s journal has been reversed, so the ledger no longer carries its credit. Reconcile it by hand.`,
    );
  }
  const subtypes = controlSubtypes(side);
  const [sum] = (side === 'customer'
    ? await sql`
        SELECT COALESCE(SUM(jl.credit - jl.debit), 0) AS posted
        FROM gl_journal_lines jl
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
        WHERE jl.journal_entry_id = ${journalId}::UUID AND jl.company_id = ${companyId}::UUID
          AND ga.account_subtype = ANY(${subtypes}::TEXT[])`
    : await sql`
        SELECT COALESCE(SUM(jl.debit - jl.credit), 0) AS posted
        FROM gl_journal_lines jl
        JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
        WHERE jl.journal_entry_id = ${journalId}::UUID AND jl.company_id = ${companyId}::UUID
          AND ga.account_subtype = ANY(${subtypes}::TEXT[])`) as DbRow[];
  return { journalId, posted: Math.max(0, round2(Number(sum?.posted ?? 0))) };
}

/**
 * The same figure for MANY notes in one statement, as a LATERAL to join on a `credit_notes cn` row: `pc.posted`, the
 * note journal's own control movement (0 when it is not posted). Whether its chain STANDS is a recursive walk per
 * note — `notesJournalStanding` below. The auto-apply back-fill's population reads both, so its dry run caps exactly
 * as the live path's `readNotePostedCredit` does. No lock: a population read.
 */
export function notePostedCreditLateral(side: CreditNoteSide) {
  const movement = side === 'customer' ? sql`jl.credit - jl.debit` : sql`jl.debit - jl.credit`;
  return sql`LEFT JOIN LATERAL (
      SELECT COALESCE((SELECT SUM(${movement}) FROM gl_journal_lines jl
                       JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = jl.company_id
                       WHERE jl.journal_entry_id = je.id AND jl.company_id = je.company_id
                         AND ga.account_subtype = ANY(${controlSubtypes(side)}::TEXT[])), 0) AS posted
      FROM gl_journal_entries je
      WHERE je.id = cn.gl_journal_entry_id AND je.company_id = cn.company_id AND je.status = 'posted'
    ) pc ON TRUE`;
}

/** For each journal id: does its reversal chain stand (O, or O <- R <- R2)? Unlocked — a population read. */
export async function notesJournalStanding(companyId: string, journalIds: readonly string[]): Promise<Set<string>> {
  const standing = new Set<string>();
  for (const id of new Set(journalIds)) {
    const root = (await findJournalChainRoot(companyId, id)) ?? id;
    const head = await findJournalChainHead(companyId, root);
    if (head?.kind === 'head' && head.standing) standing.add(id);
  }
  return standing;
}

/**
 * `readNotePostedCredit` for a PLAN: its refusal re-raised as the caller's own refusal type (decided from reads, so
 * a toolError / 4xx), anything else — a reversal-lock timeout, which is retryable — passed through untouched.
 */
export async function readPostedCreditOrRefuse(
  companyId: string, note: NoteRef, side: CreditNoteSide, refusal: (message: string) => Error,
): Promise<NotePostedCredit> {
  try {
    return await readNotePostedCredit(companyId, note, side);
  } catch (err) {
    if (err instanceof CreditNotePostedCreditError) throw refusal(err.message);
    throw err;
  }
}

/** Why an increase past the posted credit is refused — named for the zero case, which is a chart fault. */
export function postedCreditRefusal(
  number: string, posted: number, appliedBefore: number, total: number, extra?: number,
): string {
  if (posted <= HALF_CENT) {
    return `Credit note ${number}'s journal posted nothing to an AR/AP control account (an account typed receivable `
      + 'or payable), so none of it can be applied. Reclassify the account subtype or repost the note.';
  }
  const wanted = extra !== undefined ? `${formatMoney(extra)} more would apply credit` : 'the rest would be credit';
  return `Credit note ${number}'s journal put ${formatMoney(posted)} on the control account and `
    + `${formatMoney(appliedBefore)} is already applied; ${wanted} that was never posted `
    + `(${formatMoney(Math.max(0, round2(total - posted)))} of its ${formatMoney(total)} total).`;
}

/**
 * THE INVARIANT, checked immediately before an application is recorded: a write
 * may never INCREASE what the note has applied beyond what its journal posted —
 * `appliedAfter <= max(posted, appliedBefore)`. The plans already refuse it;
 * this is the backstop if a plan and the ledger ever disagree.
 */
export async function assertApplicationWithinPostedCredit(
  companyId: string,
  note: NoteRef,
  side: CreditNoteSide,
  appliedBefore: number,
  appliedAfter: number,
): Promise<NotePostedCredit> {
  const credit = await readNotePostedCredit(companyId, note, side);
  const ceiling = Math.max(credit.posted, round2(appliedBefore));
  if (round2(appliedAfter) > ceiling + HALF_CENT) {
    throw new CreditNotePostedCreditError(
      `Credit note ${String(note.credit_note_number ?? '')} would have ${formatMoney(round2(appliedAfter))} applied, `
      + `but its journal put only ${formatMoney(credit.posted)} on the control account. An application must be `
      + 'backed by the posted amount; nothing was recorded.',
    );
  }
  return credit;
}
