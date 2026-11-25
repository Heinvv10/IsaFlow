/**
 * Types of the intercompany loan reconciliation report (P5, read only; plan docs/plans/2026-11-24-intercompany-p5-reconciliation.md,
 * sections (k) and (l) binding). The database answers per message through `intercompany_loan_recon_messages` (b3) and once per connection
 * through `intercompany_loan_recon_summary` (b4), migration 1030; the service (`loanReconService.ts`) names each message's bucket, checks the
 * identities and pages the sections. Every money figure is rand, 2 dp, debit minus credit.
 */

/** b0: whether the partner's facts may be shown (relationship first, then S's own set-up, then the partner's: (l).2). */
export const PARTNER_STATES = [
  'ok', 'connection_not_active', 'not_group', 'not_one_group', 'loan_unset', 'partner_flag_off', 'partner_setup',
] as const;
export type PartnerState = (typeof PARTNER_STATES)[number];

/** b2: the payer side of a message, allocation facts now, its journal chain as at T. */
export const PAYER_STATES = ['standing', 'allocation_gone', 'changed', 'payment_not_posted', 'journal_reversed', 'dated_after', 'bill_gone'] as const;
export type PayerState = (typeof PAYER_STATES)[number];

export const RECEIVER_STATES = ['not_accepted', 'clearing_standing', 'clearing_voided', 'clearing_dated_after', 'target_missing'] as const;
export type ReceiverState = (typeof RECEIVER_STATES)[number];

export const PARTNER_DOCUMENTS = ['open', 'not_open', 'gone', 'currency'] as const;
export type PartnerDocument = (typeof PARTNER_DOCUMENTS)[number];

export const MESSAGE_STATUSES = ['pending', 'failed', 'rejected', 'dismissed', 'accepted', 'withdrawn'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** `out` = this company sent it (it is the payer), `in` = it received it. Names rows; never enters the arithmetic ((l).1). */
export type Direction = 'out' | 'in';

/** (l).4: every message falls in exactly one bucket, first match wins. */
export const BUCKETS = [
  'withdrawn', 'loan_account_changed', 'anomaly', 'payer_timing', 'timing', 'matched', 'in_flight', 'rejected_or_dismissed',
  'receiver_undone', 'payer_undone', 'not_through_loan', 'both_undone', 'not_live',
] as const;
export type Bucket = (typeof BUCKETS)[number];

/** The facts one message's bucket and contribution are judged from: b3's columns plus the session's own message row. A partner-fact
 *  input is null when the partner is withheld (b0 not ok); then no bucket and no contribution are computed ((l).3). */
export interface MessageFacts {
  status: MessageStatus;
  sourceCancelled: boolean;
  direction: Direction;
  /** round(payload.amount, 2); null when the payload carries no number (a mismatch, counted as 0). */
  amount: number | null;
  payerState: PayerState | null;
  payerCounts: boolean | null;
  payerLoanCredit: boolean | null;
  payerAfterT: boolean | null;
  payerJournalDiffers: boolean | null;
  receiverState: ReceiverState | null;
  receiverCounts: boolean | null;
  receiverAfterT: boolean | null;
  /** The clearing receipt's loan debit differs from its accepted message's amount (round 1, LOW-5). */
  receiverJournalDiffers: boolean | null;
  loanAccountChanged: boolean | null;
  partnerDocument: PartnerDocument | null;
}

/** b4's one row, as the database answers it (numbers as numeric text or null). */
export interface SummaryRow {
  partner_state: PartnerState;
  as_of: string;
  own_balance: string | number | null;
  own_attributed: string | number | null;
  own_other: string | number | null;
  own_loan_shared: boolean | null;
  partner_balance: string | number | null;
  partner_other: string | number | null;
}

/** The report's sections ((a)). */
export const SECTIONS = ['undone', 'attention', 'mismatch'] as const;
export type SectionKey = (typeof SECTIONS)[number];

export type AttentionFlag = 'failed' | 'pending_too_long' | 'unsent' | 'unlinked_partner_bill';
export type MismatchKey = 'amount' | 'currency' | 'date' | 'partner_document';

/** S's own documents a row names (looked up under company_id = S only): the only links the page draws. */
export interface OwnDocuments {
  billId: string | null;
  billNumber: string | null;
  paymentId: string | null;
  paymentNumber: string | null;
  paymentStatus: string | null;
  invoiceId: string | null;
  invoiceNumber: string | null;
  receiptId: string | null;
  receiptNumber: string | null;
}

/** The sender's display text from the payload (what both parties already read; never a link). */
export interface PayloadDisplay {
  paymentNumber: string | null;
  paymentDate: string | null;
  reference: string | null;
  payerDocumentNumber: string | null;
  currency: string | null;
}

export type ItemKind = 'message' | 'unsent' | 'unlinked_bill';

export interface ReconItem {
  kind: ItemKind;
  /** The message id, or the allocation id (unsent), or the bill id (unlinked bill). */
  id: string;
  createdAt: string | null;
  direction: Direction | null;
  status: MessageStatus | null;
  bucket: Bucket | null;
  amount: number;
  contribution: number | null;
  payerState: PayerState | null;
  receiverState: ReceiverState | null;
  partnerDocument: PartnerDocument | null;
  payerJournalDiffers: boolean | null;
  receiverJournalDiffers: boolean | null;
  flags: AttentionFlag[];
  mismatches: MismatchKey[];
  /** The stored generic error sentence of a failed message (both parties already read it). */
  error: string | null;
  sentence: string;
  display: PayloadDisplay;
  own: OwnDocuments;
  /** The pair's cut-over (the D/E rule), for the unsent rows. */
  cutover: string | null;
}

export interface Figures { balance: number; attributed: number; other: number }

export interface Component { key: Bucket; amount: number; count: number }

export interface Unexplained { total: number; ownOther: number; partnerOther: number; residualOwn: number; residualPartner: number }

export interface ReconSummary {
  partnerState: PartnerState;
  /** S's own loan account figures (null when S has no loan account on the connection). */
  own: (Figures & { loanShared: boolean }) | null;
  /** The partner's, only when partnerState is 'ok'. */
  partner: Figures | null;
  withheld: { reason: PartnerState; sentence: string } | null;
  /** null when the partner is withheld (never 0 / false as a figure, (l).3). */
  difference: number | null;
  components: Component[] | null;
  unexplained: Unexplained | null;
  reconciles: boolean | null;
  /** Rows that keep "Reconciles" off even at U = 0 ((l).6): anomaly, loan_account_changed, withdrawn, payer_journal_differs,
   *  receiver_journal_differs. */
  blockingRows: number | null;
  /** I0 / I2 failures (a code defect): shown as an "Unexplained (count)" line, never as a figure. */
  identityFailures: number;
  loanAccountChanged: boolean;
  counts: Record<SectionKey, number> & { messages: number };
  /** The `unsent` / `unlinked_partner_bill` lists hold at most MAX_RECON_LIST_ROWS rows each; true when there were more (round 1). */
  truncated: { unsent: boolean; unlinked: boolean };
}

export interface ReconReport {
  connectionId: string;
  partnerName: string;
  /** T, the statement's Africa/Johannesburg date. */
  asOf: string;
  /** statement_timestamp() of the one read. */
  readAt: string;
  summary: ReconSummary;
  section: { key: SectionKey; items: ReconItem[]; total: number; limit: number; offset: number };
}

export interface ReconConnection { id: string; partnerName: string; settlementMode: string | null; status: string }

export interface ReconQuery { section: SectionKey; limit: number; offset: number }

/** 7 calendar days, a constant ((k).13). */
export const PENDING_TOO_LONG_DAYS = 7;
/** More allocation messages than this on one connection is refused ((f)): no partial answer that would look reconciled. */
export const MAX_RECON_MESSAGES = 5000;
/** The `unsent` and `unlinked_partner_bill` lists each list at most this many rows (oldest first) and say when they were cut. */
export const MAX_RECON_LIST_ROWS = 500;
/** The highest page offset: every page re-runs the whole statement, so its cost is bounded by the caps, never by the offset; no row of a
 *  section lies beyond the capped messages plus the two capped lists. */
export const MAX_RECON_OFFSET = MAX_RECON_MESSAGES + 2 * MAX_RECON_LIST_ROWS;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** The report's statement bound, tighten-only ((f)). */
export const RECON_STATEMENT_TIMEOUT_MS = 15000;
