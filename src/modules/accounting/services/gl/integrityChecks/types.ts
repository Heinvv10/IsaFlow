/**
 * The integrity check suite: one shape for thirteen questions an auditor asks.
 *
 * Every one of these was a finding that took hours to locate by hand on
 * Brightsphere or Velocity Fibre. The point of the suite is not that each query
 * is clever — most are a dozen lines — but that asking them is a single call
 * instead of a day.
 *
 * A CHECK REPORTS. IT NEVER FILTERS THE BOOK. Each returns the number of rows
 * that fail it, the money behind them, and a bounded sample so the reader can
 * go and look. `count` and `amount` are computed over EVERY failing row, never
 * over the sample — a check whose total is the total of its own first fifty
 * rows is the aged-debtors defect wearing a different hat.
 */

/** Stable ids. Callers select checks by these; they do not change across releases. */
export const INTEGRITY_CHECK_IDS = [
  'invoices_null_due_date',
  'vat_displayed_differs_from_posted',
  'journal_date_differs_from_bank_date',
  'duplicate_bank_references',
  'deactivated_accounts_with_balance',
  'asset_accounts_with_credit_balance',
  'cost_of_sales_typed_as_expense',
  'clearing_accounts_not_nil',
  'duplicate_control_accounts',
  'documents_outside_open_period',
  'stale_suggested_transactions',
  'test_records_in_production',
  'invoices_without_revenue_line',
] as const;

export type IntegrityCheckId = (typeof INTEGRITY_CHECK_IDS)[number];

export function isIntegrityCheckId(value: unknown): value is IntegrityCheckId {
  return typeof value === 'string' && (INTEGRITY_CHECK_IDS as readonly string[]).includes(value);
}

/** How much a failing row costs. `blocks_filing` is worse than `overstates_a_figure`. */
export type IntegritySeverity = 'high' | 'medium' | 'low';

export interface IntegritySampleRow {
  /** Primary key of the failing record, so the reader can go and open it. */
  id: string;
  /** Invoice number, journal number, account code — whatever names it to a human. */
  label: string;
  /** The money at stake on THIS row, where the row has any. */
  amount?: number;
  /** Anything else the check wants the reader to see. Never parsed. */
  detail?: string;
}

export interface IntegrityCheckResult {
  id: IntegrityCheckId;
  label: string;
  severity: IntegritySeverity;
  /** Failing rows in TOTAL, not in the sample. */
  count: number;
  /** Money behind every failing row, not just the sampled ones. Null when the check has no money. */
  amount: number | null;
  /** A bounded sample. `count > sample.length` means there are more. */
  sample: IntegritySampleRow[];
  /** What the check asked, in one sentence, and what a failure means. */
  finding: string;
}

export interface IntegrityCheckContext {
  companyId: string;
  /** Reporting date. Rows dated after it are out of scope. */
  asAt: string;
  /** Cap on sampled rows per check. Never caps `count` or `amount`. */
  limit: number;
}

export type IntegrityCheckFn = (ctx: IntegrityCheckContext) => Promise<IntegrityCheckResult>;

export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

export function r2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}
