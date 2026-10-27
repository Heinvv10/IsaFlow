/**
 * The refusal census of a fiscal-period rebuild (fiscalYearStartChange.ts):
 * everything that would make deleting a company's periods and building them on
 * another start month lose or shift something.
 *
 * Three kinds of row count:
 *
 *   1. Rows that point at a period by id: journals (draft included, since the
 *      resolve_je_fiscal_period trigger has already pointed a draft at its
 *      period), gl_account_balances, close_runs (its FK CASCADEs, so only this
 *      count stops a DELETE taking it along), gl_entry_date_corrections,
 *      consolidation_adjustments and audit_trail_exports (no FK at all).
 *      Journals are counted for the whole company, with or without a period.
 *   2. Periods that are no longer 'open' (closing, closed, locked): recreating
 *      them would reopen them.
 *   3. Rows keyed by fiscal-year NUMBER for this company: accounting_budgets,
 *      afs_documents, disclosure_notes_manual. On a new start month the same
 *      number names different months, so their meaning would shift silently.
 *      accounting_budgets is now only the per-year header (notes); the budget
 *      AMOUNTS are keyed by calendar month (budget_month_amounts, migration
 *      944), never shift with a start month, and are not counted. The budget
 *      VERSIONS (budget_versions, migration 947) are keyed by year number, so
 *      they count under `budgets` with the headers.
 *
 * Deliberately not counted: payroll's period_year / balance_year columns (the
 * SARS tax year, which no company start month moves), practice_jobs.financial_year
 * (free text about a practice's CLIENT, keyed by the practice's company_id),
 * company_groups.financial_year_start (a group's own setting).
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

export type FiscalPeriodReferences = Record<
  | 'journals' | 'accountBalances' | 'closeRuns' | 'dateCorrections' | 'consolidationAdjustments' | 'auditTrailExports'
  | 'nonOpenPeriods' | 'budgets' | 'afsDocuments' | 'disclosureNotes',
  number
>;

export const NO_REFERENCES: FiscalPeriodReferences = {
  journals: 0, accountBalances: 0, closeRuns: 0, dateCorrections: 0, consolidationAdjustments: 0,
  auditTrailExports: 0, nonOpenPeriods: 0, budgets: 0, afsDocuments: 0, disclosureNotes: 0,
};

export async function countFiscalPeriodReferences(companyId: string): Promise<FiscalPeriodReferences> {
  const rows = (await sql`
    WITH p AS (SELECT id FROM fiscal_periods WHERE company_id = ${companyId}::UUID)
    SELECT
      (SELECT COUNT(*) FROM gl_journal_entries WHERE company_id = ${companyId}::UUID
          OR fiscal_period_id IN (SELECT id FROM p))::int AS journals,
      (SELECT COUNT(*) FROM gl_account_balances WHERE fiscal_period_id IN (SELECT id FROM p))::int AS account_balances,
      (SELECT COUNT(*) FROM close_runs WHERE fiscal_period_id IN (SELECT id FROM p))::int AS close_runs,
      (SELECT COUNT(*) FROM gl_entry_date_corrections WHERE old_fiscal_period_id IN (SELECT id FROM p)
          OR new_fiscal_period_id IN (SELECT id FROM p))::int AS date_corrections,
      (SELECT COUNT(*) FROM consolidation_adjustments WHERE fiscal_period_id IN (SELECT id FROM p))::int AS consolidation_adjustments,
      (SELECT COUNT(*) FROM audit_trail_exports WHERE fiscal_period_id IN (SELECT id FROM p))::int AS audit_trail_exports,
      (SELECT COUNT(*) FROM fiscal_periods WHERE company_id = ${companyId}::UUID AND status <> 'open')::int AS non_open_periods,
      ((SELECT COUNT(*) FROM accounting_budgets WHERE company_id = ${companyId}::UUID)
        + (SELECT COUNT(*) FROM budget_versions WHERE company_id = ${companyId}::UUID))::int AS budgets,
      (SELECT COUNT(*) FROM afs_documents WHERE company_id = ${companyId}::UUID)::int AS afs_documents,
      (SELECT COUNT(*) FROM disclosure_notes_manual WHERE company_id = ${companyId}::UUID)::int AS disclosure_notes
  `) as DbRow[];
  const r = rows[0]!;
  return {
    journals: Number(r.journals),
    accountBalances: Number(r.account_balances),
    closeRuns: Number(r.close_runs),
    dateCorrections: Number(r.date_corrections),
    consolidationAdjustments: Number(r.consolidation_adjustments),
    auditTrailExports: Number(r.audit_trail_exports),
    nonOpenPeriods: Number(r.non_open_periods),
    budgets: Number(r.budgets),
    afsDocuments: Number(r.afs_documents),
    disclosureNotes: Number(r.disclosure_notes),
  };
}

export const periodsInUse = (refs: FiscalPeriodReferences): boolean => Object.values(refs).some((n) => n > 0);
