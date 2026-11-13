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
 *     imported note whose journal was rounded apart from its header). Applying
 *     the full total then counts the difference as used with no journal behind
 *     it: re-applying CN-388 (Velocity, Nov 2026) consumed R0.01 that way.
 *
 * The movement is read the way the subledger reconciliation reads it
 * (`reconciliation/creditNoteRelief.ts`): a customer note CREDITS the
 * receivable, a supplier note DEBITS the payable, on accounts typed by subtype.
 * An approval posts its control leg through `getSystemAccount('receivable' |
 * 'payable')`, which resolves by that same subtype, so a note approved in
 * IsaFlow always reads its full total here.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
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

/** Exact cents: R0.01 unbacked is the defect this exists to refuse. */
const HALF_CENT = 0.005;

export interface NotePostedCredit {
  journalId: string;
  /** The note's net movement on the control account, in the note's direction. */
  posted: number;
}

/**
 * The note's live journal and what it put on the control account. Throws when
 * the note has no posted, unreversed journal — nothing it applies is backed.
 */
export async function readNotePostedCredit(
  companyId: string,
  note: { gl_journal_entry_id?: unknown; credit_note_number?: unknown },
  side: CreditNoteSide,
): Promise<NotePostedCredit> {
  const label = `Credit note ${String(note.credit_note_number ?? '')}`.trim();
  const journalId = note.gl_journal_entry_id ? String(note.gl_journal_entry_id) : null;
  if (!journalId) {
    throw new CreditNotePostedCreditError(
      `${label} has no posted journal behind it, so no credit is in the ledger to apply. Reconcile it by hand.`,
    );
  }
  const subtypes = (side === 'customer' ? RECEIVABLE_SUBTYPES : PAYABLE_SUBTYPES) as string[];
  const rows = (side === 'customer'
    ? await sql`
        SELECT je.status, je.reversed_at,
               COALESCE(SUM(jl.credit - jl.debit) FILTER (WHERE ga.account_subtype = ANY(${subtypes}::TEXT[])), 0) AS posted
        FROM gl_journal_entries je
        LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
        LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = je.company_id
        WHERE je.id = ${journalId}::UUID AND je.company_id = ${companyId}::UUID
        GROUP BY je.id, je.status, je.reversed_at`
    : await sql`
        SELECT je.status, je.reversed_at,
               COALESCE(SUM(jl.debit - jl.credit) FILTER (WHERE ga.account_subtype = ANY(${subtypes}::TEXT[])), 0) AS posted
        FROM gl_journal_entries je
        LEFT JOIN gl_journal_lines jl ON jl.journal_entry_id = je.id AND jl.company_id = je.company_id
        LEFT JOIN gl_accounts ga ON ga.id = jl.gl_account_id AND ga.company_id = je.company_id
        WHERE je.id = ${journalId}::UUID AND je.company_id = ${companyId}::UUID
        GROUP BY je.id, je.status, je.reversed_at`) as DbRow[];
  const je = rows[0];
  if (!je || String(je.status) !== 'posted') {
    throw new CreditNotePostedCreditError(`${label}'s journal is not posted, so no credit is in the ledger to apply.`);
  }
  if (je.reversed_at != null) {
    throw new CreditNotePostedCreditError(
      `${label}'s journal has been reversed, so the ledger no longer carries its credit. Reconcile it by hand.`,
    );
  }
  return { journalId, posted: Math.max(0, round2(Number(je.posted))) };
}

/**
 * THE INVARIANT, checked immediately before an application is recorded: what
 * the note will have applied in total must not exceed what its journal posted.
 * The plans already cap at it; this is the backstop that refuses to record an
 * application the ledger does not carry if a plan and the ledger ever disagree.
 */
export async function assertApplicationWithinPostedCredit(
  companyId: string,
  note: { gl_journal_entry_id?: unknown; credit_note_number?: unknown },
  side: CreditNoteSide,
  appliedAfter: number,
): Promise<NotePostedCredit> {
  const credit = await readNotePostedCredit(companyId, note, side);
  if (round2(appliedAfter) > credit.posted + HALF_CENT) {
    throw new CreditNotePostedCreditError(
      `Credit note ${String(note.credit_note_number ?? '')} would have ${formatMoney(round2(appliedAfter))} applied, `
      + `but its journal put only ${formatMoney(credit.posted)} on the control account. An application must be `
      + 'backed by the posted amount; nothing was recorded.',
    );
  }
  return credit;
}
