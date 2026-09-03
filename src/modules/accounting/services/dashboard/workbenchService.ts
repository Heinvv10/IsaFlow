/**
 * Workbench Service — exception-first signals for the accounting workbench.
 *
 * Returns six counts/values that flag items requiring accountant attention.
 * Every query is scoped by company_id. All six run in parallel.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface WorkbenchMetrics {
  unreconciledBankTxns: number;
  draftInvoices: number;
  apDueThisWeek: number;
  unpostedJournals: number;
  openPriorPeriods: number;
  vatEstimateCurrentPeriod: number;
}

type Row = DbRow;

/** Count bank_transactions not yet reconciled or matched for the company. */
async function getUnreconciledBankTxns(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS cnt
    FROM bank_transactions
    WHERE company_id = ${companyId}::UUID
      AND status NOT IN ('reconciled', 'matched', 'excluded')
  `) as Row[];
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Count invoices in draft status across both customer and supplier invoices.
 * customer_invoices.status = 'draft'
 * supplier_invoices.status = 'draft'
 */
async function getDraftInvoices(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT (
      (
        SELECT COUNT(*)::int
        FROM customer_invoices
        WHERE company_id = ${companyId}::UUID
          AND status = 'draft'
      ) +
      (
        SELECT COUNT(*)::int
        FROM supplier_invoices
        WHERE company_id = ${companyId}::UUID
          AND status = 'draft'
      )
    ) AS cnt
  `) as Row[];
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Count supplier invoices due within the next 7 days that are not yet paid.
 * Status can be anything except 'paid' or 'cancelled'.
 */
async function getApDueThisWeek(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS cnt
    FROM supplier_invoices
    WHERE company_id = ${companyId}::UUID
      AND due_date >= CURRENT_DATE
      AND due_date <= CURRENT_DATE + INTERVAL '7 days'
      AND status NOT IN ('paid', 'cancelled')
  `) as Row[];
  return Number(rows[0]?.cnt ?? 0);
}

/** Count gl_journal_entries in draft (not yet posted) for the company. */
async function getUnpostedJournals(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS cnt
    FROM gl_journal_entries
    WHERE company_id = ${companyId}::UUID
      AND status = 'draft'
  `) as Row[];
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Count fiscal periods that are still 'open' but ended before the start of
 * the current operating period (i.e. the earliest open period whose start_date
 * is >= today).  If no open period covers today, falls back to CURRENT_DATE.
 */
async function getOpenPriorPeriods(companyId: string): Promise<number> {
  const rows = (await sql`
    WITH current_period AS (
      SELECT COALESCE(
        MIN(start_date),
        CURRENT_DATE
      ) AS cutoff
      FROM fiscal_periods
      WHERE company_id = ${companyId}::UUID
        AND status = 'open'
        AND start_date <= CURRENT_DATE
        AND end_date   >= CURRENT_DATE
    )
    SELECT COUNT(*)::int AS cnt
    FROM fiscal_periods fp, current_period cp
    WHERE fp.company_id = ${companyId}::UUID
      AND fp.status     = 'open'
      AND fp.end_date   < cp.cutoff
  `) as Row[];
  return Number(rows[0]?.cnt ?? 0);
}

/**
 * Net VAT estimate for the current fiscal period:
 *   SUM of vat_output lines  (credit side of vat_output accounts)
 *   minus SUM of vat_input lines (debit side of vat_input accounts)
 * Positive = VAT payable; negative = VAT refundable.
 *
 * Reuses the same join pattern as vatReturnService: gl_journal_lines →
 * gl_journal_entries → gl_accounts where account_subtype IN ('vat_input', 'vat_output').
 * Only 'posted' journals are counted.
 */
async function getVatEstimateCurrentPeriod(companyId: string): Promise<number> {
  const rows = (await sql`
    WITH current_period AS (
      SELECT id, start_date, end_date
      FROM fiscal_periods
      WHERE company_id = ${companyId}::UUID
        AND status     = 'open'
        AND start_date <= CURRENT_DATE
        AND end_date   >= CURRENT_DATE
      ORDER BY start_date DESC
      LIMIT 1
    ),
    vat_lines AS (
      SELECT
        ga.account_subtype,
        COALESCE(jl.credit, 0) AS credit,
        COALESCE(jl.debit,  0) AS debit
      FROM gl_journal_lines   jl
      JOIN gl_journal_entries je ON je.id  = jl.journal_entry_id
      JOIN gl_accounts        ga ON ga.id  = jl.gl_account_id
      JOIN current_period     cp ON TRUE
      WHERE je.company_id   = ${companyId}::UUID
        AND jl.company_id   = ${companyId}::UUID
        AND je.status       = 'posted'
        AND je.entry_date  >= cp.start_date
        AND je.entry_date  <= cp.end_date
        -- V-05: exclude vatSubmissionService's clearing journal. It moves the
        -- whole filed period's output and input tax back off these two control
        -- accounts, which inverted this tile's sign — demo company 2026-08 read
        -- -R42,856.25 (a refund from SARS) against a true +R50,266.28 payable.
        -- The V-05 date change dates that journal day 1 of the FOLLOWING
        -- period, so without this the current period's tile is polluted by the
        -- previous period's settlement every period. IS DISTINCT FROM, not <>:
        -- source is nullable and an inequality against NULL yields NULL, which
        -- would drop every NULL-source journal. 'auto_vat_adjustment' is a
        -- separate value in gl_journal_entries_source_check and is still
        -- counted. Full rationale at the same predicate in vatReturnService.
        AND je.source IS DISTINCT FROM 'auto_vat_submission'
        AND ga.account_subtype IN ('vat_input', 'vat_output')
    )
    SELECT
      COALESCE(
        SUM(CASE WHEN account_subtype = 'vat_output' THEN credit - debit ELSE 0 END) -
        SUM(CASE WHEN account_subtype = 'vat_input'  THEN debit - credit ELSE 0 END),
        0
      )::numeric AS vat_estimate
    FROM vat_lines
  `) as Row[];
  return Number(rows[0]?.vat_estimate ?? 0);
}

/** Run all six metrics in parallel. Each query is independently scoped by company_id. */
export async function getWorkbenchMetrics(companyId: string): Promise<WorkbenchMetrics> {
  const [
    unreconciledBankTxns,
    draftInvoices,
    apDueThisWeek,
    unpostedJournals,
    openPriorPeriods,
    vatEstimateCurrentPeriod,
  ] = await Promise.all([
    getUnreconciledBankTxns(companyId),
    getDraftInvoices(companyId),
    getApDueThisWeek(companyId),
    getUnpostedJournals(companyId),
    getOpenPriorPeriods(companyId),
    getVatEstimateCurrentPeriod(companyId),
  ]);

  log.info('Workbench metrics computed', {
    companyId,
    unreconciledBankTxns,
    draftInvoices,
    apDueThisWeek,
    unpostedJournals,
    openPriorPeriods,
    vatEstimateCurrentPeriod,
  }, 'workbench-service');

  return {
    unreconciledBankTxns,
    draftInvoices,
    apDueThisWeek,
    unpostedJournals,
    openPriorPeriods,
    vatEstimateCurrentPeriod,
  };
}
