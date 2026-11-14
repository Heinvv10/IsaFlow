/**
 * Shapes of the per-party ledger check (`party_ledger_check`).
 *
 * ORIENTATION. Every signed figure here points the way the statement points:
 * POSITIVE means the party owes us (customer) or we owe the party (supplier).
 * The statement effect of a document, the aged balance and the control-account
 * movement are all expressed that way, so a clean document has the same number
 * on every view and a difference is one subtraction, never a sign flip.
 */

export type PartyType = 'supplier' | 'customer';
export type PartyDocKind = 'invoice' | 'credit_note' | 'payment' | 'write_off';

/**
 * Why a document's views differ. Machine-stable: callers branch on these.
 *
 * The first block are STATEMENT-vs-GL classes (they attribute the document's
 * difference between what the statement counts and what its own journal put on
 * the control account); the second block are SUBLEDGER-TRAIL classes (a
 * settlement the document records that its allocation rows do not support).
 */
export type MismatchClass =
  | 'document_not_linked_to_journal'
  | 'settlement_with_no_journal'
  | 'journal_not_posted'
  | 'journal_dated_after_as_at'
  | 'reversed_journal_live_document'
  | 'excluded_document_has_live_journal'
  | 'cancelled_payment_journal_stands'
  | 'posted_to_non_control_account'
  | 'journal_amount_differs'
  | 'write_off_not_on_statement'
  | 'amount_paid_differs_from_allocations'
  | 'applied_differs_from_allocations'
  | 'unclassified_difference'
  | 'shared_journal_unattributable';

/**
 * statement_vs_gl      attributes the document's statement-minus-GL difference.
 * subledger_trail      a settlement the document records that its allocation rows do not support.
 * shared_journal       the document's journal is shared and its own leg cannot be told apart;
 *                      OUTSIDE every difference and the residual.
 */
export type FlagBridge = 'statement_vs_gl' | 'subledger_trail' | 'shared_journal';

export interface PartyFlag {
  class: MismatchClass;
  bridge: FlagBridge;
  /** Signed, in the orientation above. For `statement_vs_gl`: statement effect minus GL net. */
  amount: number;
  detail: string;
  /** `posted_to_non_control_account` only: where the value went instead. */
  postedTo?: Array<{ code: string; name: string; net: number }>;
}

/** What the SQL knows about a document's own journal chain (original plus its reversals). */
export interface JournalFacts {
  journalId: string | null;
  /** Status of the linked entry, or null when there is no link / the row is missing. */
  status: string | null;
  /** 'YYYY-MM-DD' of the linked entry. */
  entryDate: string | null;
  /** Net of the chain's posted lines (dated on or before as_at) on the control accounts. */
  controlNet: number;
  controlLines: number;
  /** Posted entries reversing the original, dated on or before as_at. */
  reversalsInForce: number;
  /** Net on every other account the chain touched, nonzero only. */
  nonControl: Array<{ code: string; name: string; net: number }>;
}

export interface PartyDocument {
  kind: PartyDocKind;
  id: string;
  number: string | null;
  /** 'YYYY-MM-DD'. */
  date: string;
  status: string | null;
  statement: {
    /** Signed contribution to the statement balance. 0 when the statement leaves the document off. */
    effect: number;
    onStatement: boolean;
    /** Machine code from the statement's own `excluded` list, or why the kind never appears. */
    excludedReason: string | null;
  };
  subledger: {
    total: number;
    /** Settled as at the date: an invoice's rewound amount_paid, a credit note's applied_amount. */
    settled: number | null;
    /** Invoices only: what aged_debtors / aged_creditors shows for this document. */
    outstanding: number | null;
    /** Sum of the allocation rows (dated on or before as_at where they carry a date). */
    allocated: number | null;
    /** Payments and credit notes: value no document has consumed. */
    unapplied: number | null;
  };
  gl: {
    journalId: string | null;
    journalStatus: string | null;
    /** The document's OWN leg: the whole chain for a journal it alone claims, its attributed share of a shared one. */
    controlNet: number;
    reversalsInForce: number;
    /**
     * own             the journal is this document's alone.
     * line_match      shared; the journal's control lines match its documents' amounts one to one.
     * batch_total     shared by the members of one payment batch whose total equals the journal's control leg.
     * unattributable  shared and neither holds: no leg is counted for it, and nothing it did is compared.
     */
    attribution: 'own' | 'line_match' | 'batch_total' | 'unattributable';
    /** Ids of the other documents (any party) that carry the same journal. */
    sharedWith: string[];
  };
  /** statement.effect minus gl.controlNet, to the cent. Null when the company has no control account to compare against. */
  difference: number | null;
  flags: PartyFlag[];
}

export interface PartyInvariant {
  name: string;
  holds: boolean;
  detail: string;
}

export interface FlagClassTotal {
  class: MismatchClass;
  count: number;
  amount: number;
}

export interface PartyLedgerTotals {
  /** The statement's closing balance (supplier_statement / customer_statement). */
  statementBalance: number;
  /** Open documents per aged_creditors / aged_debtors for this party. */
  agedNet: number;
  /** Net of the party's documents' own journals on the control accounts. Null when no control account exists. */
  glControlNet: number | null;
  /** statementBalance less the documents on an unattributable shared journal, less glControlNet. */
  statementMinusGl: number | null;
  /** The part of it carried by a named class. */
  classifiedDifference: number | null;
  /** statementMinusGl - classifiedDifference. Zero is necessary, not sufficient. */
  unexplainedResidual: number | null;
  /** agedNet - statementBalance, and the items that account for it. */
  agedMinusStatement: number;
  agedBridge: {
    unappliedCash: number;
    unappliedCredit: number;
    writeOffs: number;
    amountPaidWithoutAllocation: number;
    unexplained: number;
  };
  /** Documents whose journal is shared and cannot be split: their statement effect is out of statementMinusGl. */
  sharedJournalUnattributable: { documents: number; statementEffect: number };
  documents: { total: number; flagged: number };
  byClass: FlagClassTotal[];
}

export interface UnattributedControlPostings {
  scope: 'company';
  /** Control-account journals no document claims, company-wide: a bare journal names no party. */
  count: number;
  /** Their net movement in the statement orientation. */
  net: number;
}

export interface PartyLedgerCheck {
  partyType: PartyType;
  party: { id: string; name: string };
  as_at: string;
  controlAccounts: Array<{ accountId: string; accountCode: string; accountName: string; balance: number }>;
  totals: PartyLedgerTotals;
  documents: PartyDocument[];
  invariants: PartyInvariant[];
  unattributed: UnattributedControlPostings;
  postedThrough: string | null;
}
