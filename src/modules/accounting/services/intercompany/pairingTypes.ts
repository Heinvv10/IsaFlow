/** Types shared by the intercompany pairing (P3) service, its validation and its routes. */

/** Which of this company's documents are being paired: its open customer invoices (`ar`) or its open bills (`ap`). */
export type PairingDirection = 'ar' | 'ap';
export type PairingDocType = 'customer_invoice' | 'supplier_invoice';

/** One open document as the pairing screen shows it: the same few fields for this company's own and for the partner's. */
export interface PairingDoc {
  id: string;
  number: string;
  /** YYYY-MM-DD */
  date: string;
  total: number;
  open: number;
  currency: string;
}

/** A pair of documents, this company's and the partner's, that the screen proposes or lists as an amount mismatch. */
export interface PairingCandidate {
  mine: PairingDoc;
  theirs: PairingDoc;
  /** The number appears more than once on a side, so the pairing is a guess a person must check. */
  ambiguous: boolean;
  /** The documents' open amounts differ (one side has been part-paid, or the totals differ). */
  openDiffers: boolean;
}

export interface PairingMatches {
  /** Same number and total. */
  suggestions: PairingCandidate[];
  /** Same number, different total. */
  mismatches: PairingCandidate[];
  unmatchedMine: PairingDoc[];
  unmatchedTheirs: PairingDoc[];
  /** Foreign-currency documents (either side): the pairing is ZAR only. */
  unsupported: PairingDoc[];
}

export type PairingLinkStatus = 'pending_confirmation' | 'active';
/** Who must act on a pending pairing: this company (the partner proposed it) or the partner (this company did). */
export type PairingAwaiting = 'me' | 'partner';

/** A pairing already recorded on this connection (a document link), as this company sees it. */
export interface PairingLinkView {
  id: string;
  status: PairingLinkStatus;
  awaiting: PairingAwaiting | null;
  /** The partner's proposal, but this company's document is already in another pairing: it can only be declined. */
  conflict: boolean;
  mine: PairingDoc | null;
  /** Null when the partner's document is no longer open (or not offered), so only its number is unknown. */
  theirs: PairingDoc | null;
  createdAt: string;
}

/** Why the screen offers no suggestions: the person is told what to do, not left with an empty table. */
export type PairingBlock = 'revoked' | 'no_cutover' | 'no_party' | 'no_write_access';

export interface LoanDifference {
  /** This company's loan account, as net debit (debits less credits) of posted journals dated before the cut-over. */
  mine: number;
  /** The partner's, the same way; null while the partner has set no loan account. */
  theirs: number | null;
  /** mine + theirs: nil when one company's receivable is the other's payable. Null when the partner's is unknown. */
  difference: number | null;
  /** The last day counted (the day before the cut-over), YYYY-MM-DD. */
  asAt: string;
}

export interface PairingView {
  connectionId: string;
  partnerName: string;
  direction: PairingDirection;
  cutoverDate: string | null;
  /** Null when suggestions are offered. */
  blocked: PairingBlock | null;
  /** The signed-in user can write in both companies of a group, so a pairing made here is confirmed for both. */
  confirmsBoth: boolean;
  matches: PairingMatches;
  /** A list was cut at its limit: the person is told rather than left to wonder where a document went. */
  truncated: boolean;
  /** Pairings recorded for this direction: pending ones first. */
  links: PairingLinkView[];
  /** Null when this company has set no loan account on the connection. */
  loan: LoanDifference | null;
}

export interface PairInput {
  mineId: string;
  theirsId: string;
}

export interface PairingResult {
  created: number;
  /** Pairings that are active at once (both sides confirmed by this user); the rest wait for the partner. */
  active: number;
}
