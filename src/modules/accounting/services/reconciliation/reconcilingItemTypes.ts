/**
 * The shape of a reconciling item, and the two bridges an item can sit on.
 *
 * TWO BRIDGES, deliberately kept apart. Re-deriving Brightsphere showed the
 * specification had merged them, which is why its R1,429,774 reconciles to
 * nothing exactly:
 *
 *   aged_to_subledger    what the AGED REPORT drops but the subledger holds —
 *                        a null due date, an amount under dispute. These do NOT
 *                        explain any GL difference: the invoice's own journal is
 *                        already in the control account.
 *   subledger_to_control what the SUBLEDGER and the GL disagree about —
 *                        unapplied cash, unposted documents, documents dated
 *                        after the reporting date. This is the reconciliation
 *                        proper.
 *
 * Adding the two together produces a number that reconciles to nothing.
 */

export type ReconcilingBridge = 'aged_to_subledger' | 'subledger_to_control';

export interface ReconcilingItem {
  bridge: ReconcilingBridge;
  /** Machine-stable snake_case code. Callers branch on this, not on `description`. */
  type: string;
  description: string;
  /** Signed so that the lower figure plus the items reaches the higher one. */
  amount: number;
  /** Primary keys behind the item — invoices, payments or journal entries. */
  documentIds: string[];
  /** Human-chaseable numbers where the rows carry them. */
  documentNumbers: string[];
  /**
   * The summed GROSS value of the documents this item cites — invoice totals,
   * payment totals, a journal's own movement. An item may not claim more than
   * the documents behind it are worth, and `reconcile_subledger` checks exactly
   * that rather than assuming it: the failure this catches is an item built by
   * summing the wrong column, which looks like a finding about the books.
   *
   * Zero on the two residual items, which cite no documents and are excluded
   * from the check for that reason.
   */
  citedGross: number;
  /**
   * Σ|member amount| over the rows behind this item — the same members
   * `citedGross` sums the face values of.
   *
   * WHY THE NET AMOUNT IS NOT ENOUGH. `amount` is the group's NET, so an
   * overstated member hides behind an opposite-signed one and the check on the
   * net passes: on a production copy `posting_with_no_document` netted
   * +R124,704.80 against a cited gross of R686,504.50 because two refund
   * journals of −R120,290.00 and −R160,609.85 sat in the same group. Absolute
   * values cannot offset, so this is the figure the invariant compares.
   */
  citedAbsAmount: number;
}

/**
 * An arithmetic claim the reconciliation makes about its own output, and
 * whether it holds.
 *
 * RETURNED, NOT THROWN. A violation means these books break an assumption this
 * code makes, which is the most interesting thing the endpoint can say; a 500
 * would replace it with nothing. The tool reports the block and lets the reader
 * see both the violation and the figures that produced it.
 */
export interface ReconciliationInvariant {
  name: string;
  holds: boolean;
  detail: string;
}

/** Anything an item can cite: it needs an id, and a number when it has one. */
export interface CitableDocument {
  id: string;
  documentNumber?: string | null;
}
