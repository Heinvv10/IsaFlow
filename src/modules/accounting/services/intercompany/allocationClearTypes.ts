/**
 * Types of the receiver's CLEARING of an allocation message (intercompany P4-D): what Accept sends, what it answers, and the refusal a
 * check raises before anything is posted. Pure (no database import), so the UI and the unit tests can use them.
 */

/** What the person saw in the preview and approves: the request refuses (409, nothing posted) when the books no longer say the same. */
export interface AcceptAllocationInput {
  expectedLoanAccountId: string;
  invoiceId: string;
  amount: number;
  /** YYYY-MM-DD: on or after the payment date, not after today, in an open financial period and outside a locked VAT period. */
  postingDate: string;
}

/** Why a clearing was refused. Every one is stored on the message as `failed` with its fixed sentence; nothing is posted. */
export type ClearRefusalCode =
  | 'malformed' | 'not_live' | 'no_loan_account' | 'loan_account_unusable' | 'invoice_gone' | 'invoice_not_open' | 'wrong_customer'
  | 'currency' | 'pre_cutover_invoice' | 'pre_cutover_payment' | 'exceeds_open' | 'cash_not_through_loan' | 'already_cleared'
  | 'no_period' | 'period_locked' | 'vat_locked' | 'busy' | 'refused' | 'not_group' | 'loan_class_mismatch' | 'payer_loan_not_set_up';

export type AcceptAllocationOutcome =
  | { accepted: true; messageId: string; paymentId: string; paymentNumber: string; journalEntryId: string }
  | { accepted: false; messageId: string; status: 'failed'; code: ClearRefusalCode; error: string };

/** A refusal one of the clearing's own checks raised, before anything was posted. Known by identity (it never leaves the service: it becomes the
 *  message's `failed` sentence), so it carries no refusal `code` of its own. */
export class ClearRefusal extends Error {
  constructor(readonly reason: ClearRefusalCode) {
    super(reason);
    this.name = 'ClearRefusal';
  }
}

/** What the Accept preview shows for an open allocation message: the two legs, the amount, the invoice and the posting date it proposes. */
export interface AllocationClearingPreview {
  loanAccountId: string | null;
  /** "code name" of the receiver side's loan account (the debit), null when the side names none. */
  loanAccountLabel: string | null;
  /** "code name" of the Accounts Receivable control (the credit), null when the chart has none. */
  receivableLabel: string | null;
  amount: number | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  paymentDate: string | null;
  /** This company's invoice's date: the posting date is on or after it too (null when the invoice is gone). */
  invoiceDate: string | null;
  /** From the later of the payment and invoice dates: that date when its period is open (and not VAT-locked), else the first such date after
   *  it, never after today; null when none. */
  defaultPostingDate: string | null;
}

/** An accepted allocation message's clearing, for the handled list: the contra receipt it posted, and whether that receipt was voided since. */
export interface AllocationClearedBy {
  paymentId: string;
  paymentNumber: string | null;
  journalEntryId: string | null;
  /** The receipt's journal no longer stands (voided, reversed): read-only, computed from the journal chain; nothing re-clears it. */
  voided: boolean;
}
