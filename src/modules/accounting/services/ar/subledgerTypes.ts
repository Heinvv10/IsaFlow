/**
 * The shared shape of a subledger snapshot — one open-document view that both
 * the aging reports and `reconcile_subledger` read, so the answer to "what is
 * open" cannot differ between them.
 *
 * POINT IN TIME. `balance` is what was outstanding on the reporting date,
 * reconstructed by the same rewind the aging reports use
 * (`services/shared/agingRewind.ts`) — not the current `amount_paid`. Reading
 * the current figure made `asAtDate` decorative here in exactly the way it had
 * been on the aging reports before #306: `subledgerTotal` stayed frozen at
 * today while the control-account balance moved with the date, and the
 * difference between them closed only because a `document_after_as_at` item
 * absorbed everything raised since. On production at 2025-12-31 that item was
 * R72,867,375.59 of Velocity AR.
 *
 * `ageable` / `unageable` are SUBSETS of `documents`, not alternatives to it.
 * The subledger total is over `documents` plus `creditNotes`: a document that
 * cannot be BUCKETED still represents money owed, and dropping it from the
 * total is the R1,058,000 defect (FINDINGS §4). Note that since #303 the aging
 * reports no longer drop those rows either — they age them from
 * `invoice_date` — so `unageable` is a description of the row, not a statement
 * that the aged report omits it.
 *
 * There is no `afterAsAt`: the readers now apply the same
 * `document_date <= as_at` cutoff the aging reports and the control-account
 * balance apply, so a document dated after the reporting date is not in the
 * subledger at that date and needs no reconciling item. A document whose
 * JOURNAL is dated after the reporting date is still caught — as
 * `document_not_on_control_account`, which is what it actually is.
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
  /** Settled as at the reporting date, not the current `amount_paid`. */
  amountPaid: number;
  /**
   * Outstanding AS AT the reporting date: total_amount − the rewound
   * amount_paid. Negative on a credit note.
   */
  balance: number;
}

export interface SubledgerSnapshot {
  /** Every open document, ageable or not. */
  documents: SubledgerDocument[];
  /** Documents that CAN be bucketed — a subset of `documents`. */
  ageable: SubledgerDocument[];
  /** Documents with no due date — a subset of `documents`. Never dropped. */
  unageable: SubledgerDocument[];
  /** Unallocated approved credit notes, carried as negative balances. */
  creditNotes: SubledgerDocument[];
  /** documents + creditNotes, in full. */
  subledgerTotal: number;
  /** MAX(created_at) of the rows consumed, ISO-8601 — null when none. Never now(). */
  postedThrough: string | null;
}

/** Per-document dispute amounts, AR only; AP passes an empty map. */
export type DisputeTotals = ReadonlyMap<string, number>;
