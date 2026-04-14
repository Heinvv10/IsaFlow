/**
 * Canonical invoice status sets for AR and AP reporting.
 *
 * These constants define which statuses are counted as "open/outstanding"
 * in dashboards, aging reports, and KPI widgets.  All consumers must import
 * from here so that the dashboard, aging, and KPI always agree.
 *
 * Source of truth:
 *   AR — arAgingService.ts line 25, kpiDashboardService.ts line 96/103
 *   AP — apAgingService.ts line 24, kpiDashboardService.ts line 120/127
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
