/** Types of the receiver's allocation inbox (P4-C): what "Payments from your group" on the Bills "Intercompany" tab lists. Read only. */
import type { InboxStatus } from './inboxTypes';
import type { AllocationClearedBy, AllocationClearingPreview } from './allocationClearTypes';

/** The database's answer (`intercompany_allocation_message_live`, migration 1026), or `check_failed` when it could not be asked. */
export type AllocationLiveReason =
  | 'ok' | 'not_found' | 'not_pending' | 'link_gone' | 'before_cutover' | 'allocation_gone' | 'changed' | 'payment_not_posted' | 'journal_reversed'
  | 'bill_gone' | 'future_dated' | 'check_failed';

export const ALLOCATION_LIVE_REASONS: readonly AllocationLiveReason[] = [
  'ok', 'not_found', 'not_pending', 'link_gone', 'before_cutover', 'allocation_gone', 'changed', 'payment_not_posted', 'journal_reversed', 'bill_gone',
  'future_dated', 'check_failed',
];

/** What does not fit between the payment and the receiver's invoice, derived at read time and never stored (D refuses or caps on it). */
export type AllocationMismatch =
  | 'invoice_gone' | 'invoice_not_open' | 'currency' | 'pre_cutover_payment' | 'pre_cutover_invoice' | 'amount_exceeds_open';

/** The receiver's OWN customer invoice the payload names (looked up under the session company); null when it is not there (or deleted). */
export interface AllocationIssuerInvoice {
  id: string;
  number: string;
  /** What is still owed on it; null when the invoice is not open (draft, awaiting approval, paid): nothing can be cleared against it. */
  openAmount: number | null;
  status: string;
  currency: string;
  date: string | null;
}

export interface AllocationItem {
  id: string;
  status: InboxStatus;
  connectionId: string;
  /** The receiver's own name for the payer: the customer linked on its side of the connection. Display only. */
  senderName: string;
  /** From the payer's payload: display text only, never an identity. Null when the payload is unreadable. */
  paymentNumber: string | null;
  paymentDate: string | null;
  paymentMethod: string | null;
  paymentReference: string | null;
  amount: number | null;
  currency: string | null;
  payerDocumentNumber: string | null;
  /** The payer's journal credited its intercompany loan account (not the bank). */
  cashLegIsLoanAccount: boolean | null;
  issuerInvoice: AllocationIssuerInvoice | null;
  /** Advisory: D asks again inside its own transaction before acting. */
  live: boolean;
  liveReason: AllocationLiveReason;
  mismatch: AllocationMismatch | null;
  /** An unreadable payload, as a sentence; the item then carries no figure. */
  blocker: string | null;
  reason: string | null;
  error: string | null;
  handledAt: string | null;
  createdAt: string;
  /** P4-D: an accepted message's clearing receipt, and whether it was voided since (read-only, computed); null otherwise. */
  clearedBy: AllocationClearedBy | null;
}

export interface AllocationPage {
  items: AllocationItem[];
  total: number;
  /** Pending and failed allocation messages (not in the Bills badge: nothing can be done with one yet). */
  allocationCount: number;
  /** The dark flag `intercompany_loan_clearing` for the session company: false, the inbox offers no Accept (reject / dismiss stay). */
  loanClearingEnabled: boolean;
}

export interface AllocationDetail {
  item: AllocationItem;
  /** The payer's allocation row, the link and how it was made (payload facts; null when the payload is unreadable). */
  allocationId: string | null;
  linkId: string | null;
  linkOrigin: string | null;
  /** The connection's cut-over date (an invoice dated before it is refused by D). */
  cutoverDate: string | null;
  /** P4-D: what Accept would post, for an open message; null for a handled one, and for every one while loan clearing is off. */
  preview: AllocationClearingPreview | null;
  /** The dark flag `intercompany_loan_clearing` for the session company (as on the list). */
  loanClearingEnabled: boolean;
}
