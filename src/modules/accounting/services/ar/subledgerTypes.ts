/**
 * The shared shape of a subledger snapshot — one open-document view that both
 * the aging reports and `reconcile_subledger` read, so the answer to "what is
 * open" cannot differ between them.
 *
 * `ageable` / `unageable` / `afterAsAt` are SUBSETS of `documents`, not
 * alternatives to it. The subledger total is over `documents` plus
 * `creditNotes`: a document that cannot be aged still represents money owed,
 * and dropping it from the total is the R1,058,000 defect (FINDINGS §4).
 */

export interface SubledgerDocument {
  id: string;
  /** Invoice / bill / credit-note number, when the row has one. */
  documentNumber: string | null;
  entityId: string;
  entityName: string;
  /** Document date, 'YYYY-MM-DD'. */
  documentDate: string;
  /** 'YYYY-MM-DD', or null — NULL is data, and it is why a row cannot be aged. */
  dueDate: string | null;
  totalAmount: number;
  amountPaid: number;
  /** Outstanding: total_amount − amount_paid. Negative on a credit note. */
  balance: number;
}

export interface SubledgerSnapshot {
  /** Every open document, ageable or not. */
  documents: SubledgerDocument[];
  /** Documents that CAN be bucketed — a subset of `documents`. */
  ageable: SubledgerDocument[];
  /** Documents with no due date — a subset of `documents`. Never dropped. */
  unageable: SubledgerDocument[];
  /**
   * Documents dated after the reporting date — a subset of `documents`.
   *
   * These are in the subledger but cannot be in the control-account balance,
   * whose query stops at `entry_date <= as_at`. That is a reconciling item, not
   * an error, and it is why one of the Brightsphere differences moves with the
   * date it is asked about.
   */
  afterAsAt: SubledgerDocument[];
  /** Unallocated approved credit notes, carried as negative balances. */
  creditNotes: SubledgerDocument[];
  /** documents + creditNotes, in full. */
  subledgerTotal: number;
  /** MAX(created_at) of the rows consumed, ISO-8601 — null when none. Never now(). */
  postedThrough: string | null;
}

/** Per-document dispute amounts, AR only; AP passes an empty map. */
export type DisputeTotals = ReadonlyMap<string, number>;
