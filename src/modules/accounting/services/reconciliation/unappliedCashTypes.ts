/**
 * The shapes the two unapplied-cash mechanisms share.
 *
 * In their own file because the mechanisms live in two files — mechanism 1 in
 * `unappliedPaymentCash.ts`, mechanism 2 and the orchestration in
 * `unappliedCashService.ts` — and a type imported from the orchestrator by the
 * thing the orchestrator imports is a cycle.
 */

export interface UnappliedCashItem {
  /** Payment id (mechanism 1) or journal-entry id (mechanism 2). */
  id: string;
  /** Payment number or journal entry number. */
  documentNumber: string | null;
  /** Customer / supplier name where the row carries one; null for a bare journal. */
  entityName: string | null;
  /** 'YYYY-MM-DD'. */
  documentDate: string;
  /**
   * What this item explains of the control-account difference: the payment's
   * movement on a control account less what is allocated against it.
   */
  amount: number;
  /**
   * The same payment's unapplied remainder BY DOCUMENT — `total_amount` less
   * its allocations — which is what `list_unapplied_receipts` /
   * `list_unapplied_payments` report. Equal to `amount` when the cash is on the
   * control account; carried separately so a divergence is visible here instead
   * of being a disagreement between two tools.
   */
  documentUnapplied: number;
  /**
   * The GROSS value behind the item — the payment's `total_amount`, or the
   * journal's own movement on the control account. An item's amount can never
   * legitimately exceed it, and `reconcile_subledger` asserts that as an
   * invariant rather than trusting it.
   */
  gross: number;
}

/** A payment the subledger calls unapplied whose cash is not on control. */
export interface OffControlCash {
  paymentId: string;
  documentNumber: string | null;
  /** The document-basis remainder that is NOT on a control account. */
  amount: number;
}
