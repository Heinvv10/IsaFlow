/**
 * Types of the PAYER's "Clear against the intercompany loan" (intercompany P4-E): what the request sends, what it answers, what the bill page's
 * preview shows, and the refusal every check raises before anything is posted. Pure (no database import), so the UI and the unit tests use them.
 */
import { ConnectionRefusal } from './connectionTypes';

/** What the person saw in the preview and approves: the request refuses (409, nothing posted) when the books no longer say the same. */
export interface LoanClearExpected {
  /** The payer side's loan account (the credit). */
  loanAccountId: string;
  /** The ACTIVE link of the bill to the partner's customer invoice. */
  linkId: string;
  /** The amount the person approved (must equal the request's amount). */
  amount: number;
  /** The bill's open amount (total less paid) the preview read: a second click after a first one posted is a 409. */
  openAmount: number;
}

export interface LoanClearInput {
  billId: string;
  /** Positive, whole cents: up to the bill's open amount less pending draft / approved payments (a partial clearing is allowed). */
  amount: number;
  /** YYYY-MM-DD: on or after the bill date and the pair's cut-over, not after today, in an open period outside a locked VAT period. */
  postingDate: string;
  expected: LoanClearExpected;
}

export interface LoanClearResult {
  cleared: true;
  billId: string;
  paymentId: string;
  paymentNumber: string;
  journalEntryId: string;
  /** The allocation message the P4-B hook sent to the partner for this clearing (required: the clearing never stands without it). */
  messageId: string;
}

/** Why a clearing was refused. Every one is raised before the first write; nothing is posted or stored. */
export type PayerClearCode =
  | 'not_own_session' | 'no_write_role' | 'no_approve'
  | 'bill_not_found' | 'bill_not_open' | 'bill_paid' | 'no_link' | 'not_active' | 'not_loan' | 'not_group' | 'pre_cutover_bill'
  | 'pre_cutover_payment' | 'payer_loan_not_set_up' | 'currency' | 'wrong_supplier' | 'exceeds_open' | 'stale' | 'busy'
  | 'date_before_bill' | 'date_after_today' | 'no_period' | 'period_locked' | 'vat_locked'
  | 'receiver_not_ready' | 'approval_rule' | 'contra_refused';

/** A refusal of "Clear against the intercompany loan": a ConnectionRefusal (the routes answer it with its status and sentence) with its code. */
export class PayerClearRefusal extends ConnectionRefusal {
  constructor(readonly code: PayerClearCode, status: 400 | 403 | 404 | 409, message: string) {
    super(status, message);
    this.name = 'PayerClearRefusal';
  }
}

/** What the bill page shows before the person clears (GET loan-clearings?billId=). Read only. */
export interface LoanClearingPreview {
  /** The bill is one side of an ACTIVE link on a LOAN connection: the action is shown (even when `blocked` says why it cannot post now). */
  linked: boolean;
  billId: string;
  billNumber: string | null;
  billDate: string | null;
  linkId: string | null;
  /** The payer's own supplier record linked on its side of the connection (the partner, as these books name it). */
  partnerName: string | null;
  loanAccountId: string | null;
  /** "code name" of the payer side's loan account (the credit). */
  loanAccountLabel: string | null;
  /** "code name" of the Accounts Payable control (the debit). */
  payableLabel: string | null;
  /** The bill's total less paid. */
  openAmount: number | null;
  /** What may be cleared now: the open amount less pending draft / approved payments, never below 0. */
  maxAmount: number | null;
  /** The earliest posting date: the later of the bill date and the pair's cut-over (null when the pair has none). */
  floorDate: string | null;
  /** Today (Johannesburg): the proposed posting date. */
  defaultPostingDate: string;
  /** The partner can clear this amount against its loan account today (the receiver-readiness preflight said `ready`). */
  receiverReady: boolean;
  /** The first reason it cannot be cleared now, as the fixed sentence the POST would answer; null when it can. */
  blocked: string | null;
}
