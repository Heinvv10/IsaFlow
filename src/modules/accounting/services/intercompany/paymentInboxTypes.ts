/** Types of the receiver's Payments inbox and the payer's unsent read (intercompany F, cash mode). Read-only shapes the routes answer. */
import type { InboxStatus } from './inboxTypes';

/** D2's word (`intercompany_payment_message_state`, migration 1031), or `check_failed` when it could not be asked. */
export type PaymentState =
  | 'open' | 'connection_gone' | 'not_cash' | 'not_enabled' | 'future_dated' | 'before_cutover' | 'payer_gone' | 'link_gone' | 'currency'
  | 'target_cancelled' | 'target_ok' | 'closed' | 'not_found' | 'check_failed';

export const PAYMENT_STATES: readonly PaymentState[] = [
  'open', 'connection_gone', 'not_cash', 'not_enabled', 'future_dated', 'before_cutover', 'payer_gone', 'link_gone', 'currency', 'target_cancelled',
  'target_ok', 'closed', 'not_found', 'check_failed',
];

/** The receiver's own customer invoice the payload names (looked up under the session company). */
export interface PaymentIssuerInvoice { id: string; number: string; status: string; openAmount: number | null; currency: string; date: string | null }

/** An accepted message's receipt (the target), as the receiver's books have it. `isDraft`: the F draft stamped for this message, still draft. */
export interface PaymentTarget { paymentId: string; paymentNumber: string; status: string; isDraft: boolean }

export interface PaymentItem {
  id: string;
  status: InboxStatus;
  connectionId: string;
  /** The receiver's own name for the payer (its side's customer). Display only. */
  senderName: string;
  paymentNumber: string | null;
  paymentReference: string | null;
  paymentDate: string | null;
  paymentMethod: string | null;
  amount: number | null;
  currency: string | null;
  payerDocumentNumber: string | null;
  payerDocumentDate: string | null;
  issuerInvoice: PaymentIssuerInvoice | null;
  state: PaymentState;
  live: boolean;
  reason: string | null;
  error: string | null;
  handledAt: string | null;
  createdAt: string;
  target: PaymentTarget | null;
}

export interface PaymentPage {
  items: PaymentItem[];
  total: number;
  /** Pending payment messages to this company. */
  openCount: number;
  /** The dark flag `intercompany_loan_clearing` for the session company: false, nothing is offered to accept. */
  enabled: boolean;
}

export interface InvoiceSuggestion { id: string; number: string; date: string | null; openAmount: number; linked: boolean }
export interface ReceiptSuggestion {
  id: string; number: string; date: string; total: number; unallocated: number; unconsumed: number; exact: boolean; onLinkedInvoice: boolean; score: number;
}
/** (round 1 LOW-2) A receipt that may already hold this payment: the customer's, confirmed, dated on or after it, unconsumed cash >= the amount. */
export interface ReceiptHolder { id: string; number: string; date: string; unconsumed: number }
/** A bank line is a hint only: no action is offered on it in F. */
export interface BankLineHint { id: string; date: string; amount: number; description: string; score: number }

export interface PaymentSuggestions {
  invoices: InvoiceSuggestion[];
  receipts: ReceiptSuggestion[];
  bankLines: BankLineHint[];
  /** The receiver's active bank accounts (the draft receipt's bank leg). */
  bankAccounts: { id: string; label: string }[];
  /** False while a candidate receipt holds the linked invoice or is exactly the amount (Q2): use that receipt instead. */
  draftAllowed: boolean;
  draftRefusal: 'exact_receipt' | 'linked_receipt' | null;
  /** How many receipts may already hold this payment (LOW-2): above 0 the draft needs `confirmNoHolder` with this count; the first 20 listed. */
  holderCount: number;
  holders: ReceiptHolder[];
  /** Today (Johannesburg): the latest receipt date the draft takes. */
  today: string;
}

export interface PaymentDetail {
  item: PaymentItem;
  allocationId: string | null;
  linkId: string | null;
  cutoverDate: string | null;
  enabled: boolean;
  /** Computed on request for an open message while the flag is on; null otherwise. Never stored. */
  suggestions: PaymentSuggestions | null;
}

export type AcceptPaymentOutcome = { accepted: true; messageId: string; outcome: 'existing' | 'draft'; receiptId: string; receiptNumber: string };

export interface UnsentPayment {
  allocationId: string; paymentId: string; paymentNumber: string | null; paymentDate: string; billId: string; billNumber: string | null; amount: number;
  partnerName: string;
}

/** The payer's "paid, no payment message" read: `cannot_determine` (with a sentence) when the session cannot see the pair's group. */
export interface UnsentPage { state: 'ok' | 'cannot_determine'; sentence: string | null; items: UnsentPayment[] }
