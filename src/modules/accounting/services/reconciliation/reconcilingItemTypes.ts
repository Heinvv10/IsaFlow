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
}

/** Anything an item can cite: it needs an id, and a number when it has one. */
export interface CitableDocument {
  id: string;
  documentNumber?: string | null;
}
