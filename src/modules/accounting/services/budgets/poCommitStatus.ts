/**
 * The status sets committed spend and billing share (PR #1703 review r6 M6): a leaf with no imports, so the pure link planner
 * (`ap/purchaseOrderBillLinkPlan`) and the link types read them without pulling in the committed engine. `remainingCommitted`
 * re-exports them for its existing callers.
 */

/** PO statuses whose lines commit spend; bill statuses whose linked lines release it. */
export const COMMITTING_PO_STATUSES = ['approved', 'partially_received', 'received'] as const;
export const BILLED_STATUSES = ['approved', 'paid', 'partially_paid'] as const;

/** A PO is fully billed from this many cents short of its subtotal (Hein, 19 Nov). */
export const FULLY_BILLED_TOLERANCE_CENTS = 1;
/** Fully billed within the tolerance, and only once something is billed (Codex gate: a R0.01 order with no bills is not). */
export const isFullyBilled = (billedCents: number, subtotalCents: number): boolean =>
  billedCents > 0 && billedCents >= subtotalCents - FULLY_BILLED_TOLERANCE_CENTS;
/** Fully billed against a billing basis, never when that basis is 0 (as 1022 closes: review r8 L5). */
export const isFullyBilledBasis = (billedCents: number, basisCents: number): boolean => basisCents > 0 && isFullyBilled(billedCents, basisCents);

/**
 * May a PO commit spend? A committing status, or closed BY BILLING (purchase_orders.closed_by_billing, 1016; PR #1703 breaker r5).
 * A PO closed by billing commits 0 while it is fully billed at PO level and its per-line open remainder once it is not (review r6
 * M5: `remainingCommitted.fullyBilledClosedPos` is that check), so whatever path later leaves it under-billed (a link taking a
 * header residual, a cancel or delete racing its close) commits the unbilled rands again by itself. A close by hand and a
 * cancelled PO commit nothing.
 */
export const commitsSpend = (status: string, closedByBilling: boolean): boolean =>
  (COMMITTING_PO_STATUSES as readonly string[]).includes(status) || (status === 'closed' && closedByBilling);
