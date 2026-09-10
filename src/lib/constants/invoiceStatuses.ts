/**
 * Canonical invoice status sets for AR and AP reporting.
 *
 * These constants define which statuses are counted as "open/outstanding"
 * AT TODAY'S DATE, in dashboards, KPI widgets, consolidated reporting, bureau
 * metrics and the GL close-readiness checks. Consumers of a LIVE outstanding
 * figure import from here so those surfaces agree.
 *
 * Consumers:
 *   kpiDashboardService (4 sites), consolidatedReportingService,
 *   bureauClientMetricsService, closeReadinessChecks/arSubLedgerCheck and
 *   apSubLedgerCheck.
 *
 * THE AGING REPORTS ARE DELIBERATELY EXEMPT, and this header used to name them
 * as the source of truth. arAgingService and apAgingService now answer an
 * as-at question, and an invoice that is 'paid' TODAY was still outstanding on
 * an earlier date — filtering to the open set is exactly what erased settled
 * debt from historical aging. They exclude only never-issued and voided
 * invoices ('draft', 'cancelled') and reconstruct the balance for the date
 * asked about.
 *
 * The consequence is real and worth stating. At any EARLIER date aging will
 * legitimately differ from the dashboard, from consolidated reporting and from
 * the close gate, all of which are live-only. They can differ at TODAY too:
 * the aging reconstruction collapses to amount_paid then, but its population
 * (shared/documentPopulation — everything not draft or cancelled) is wider
 * than these sets. A 'pending_approval' document (either side), a 'disputed'
 * bill (AP only — the AR CHECK constraint has no such status), a 'paid' one
 * still carrying a balance, and a NULL-status one are in the aging and in none
 * of these. This header used to say the two agree at today; they agree only
 * where no such row exists (R-059 round 7).
 * If a future surface needs a historical figure it must use the aging
 * services, not these sets.
 *
 * NOTE: AP aging intentionally omits 'overdue' because supplier invoices that
 * have passed their due date remain in status 'approved' in this system (unlike
 * customer invoices which transition to 'overdue').  Do NOT add 'overdue' to
 * AP_OPEN_STATUSES without a matching DB migration + status-transition logic.
 */

/** Customer invoice statuses counted as open/outstanding for AR reporting and dashboards. */
export const AR_OPEN_STATUSES = [
  'approved',
  'sent',
  'partially_paid',
  'overdue',
] as const;

export type AROpenStatus = (typeof AR_OPEN_STATUSES)[number];

/** Supplier invoice statuses counted as open/outstanding for AP reporting and dashboards. */
export const AP_OPEN_STATUSES = ['approved', 'partially_paid'] as const;

export type APOpenStatus = (typeof AP_OPEN_STATUSES)[number];
