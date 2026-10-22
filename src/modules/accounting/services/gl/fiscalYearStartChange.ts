/**
 * When a company's fiscal periods may be (re)built from its financial year
 * start, and the rebuild itself.
 *
 * WHY. resolveCompanyPeriodAlignment builds every new year on the layout the
 * company's EXISTING periods use, and only falls back to
 * `companies.financial_year_start` when there are none. So the first periods a
 * company gets decide its year for good: create_company_with_owner's taxonomy
 * seeder (seed_company_fiscal_periods, migration 476) writes January–December,
 * and every onboarded company then stayed on the calendar while declaring
 * March. Two writers depend on this file:
 *
 *   - onboarding complete-setup replaces the seeder's calendar periods with the
 *     fiscal year the user chose, in the same transaction that created the
 *     company (rebuildUnusedFiscalPeriods);
 *   - a later change of financial_year_start (companyService.updateCompany) is
 *     allowed only before the first posting, and then rebuilds the periods the
 *     same way; after it, the change is refused (assertFinancialYearStartChange).
 *
 * THE GUARD. Periods are deleted and re-created only when nothing refers to
 * them: no journal of the company at all (draft included: the
 * resolve_je_fiscal_period trigger has already pointed a draft at a period), and
 * no row in any table holding a fiscal_period_id. The FKs from gl_journal_entries
 * and most others are NO ACTION and would refuse the DELETE anyway, but
 * close_runs CASCADEs and two tables have no FK at all, so the count, not the
 * constraint, is the guard.
 */

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { FiscalPeriod } from '../../types/gl.types';
import { createFiscalYear, resolveCompanyPeriodAlignment } from './fiscalYearCreateService';
import { fiscalYearOfDate } from './fiscalYearCalendar';

export type FiscalPeriodReferences = Record<
  'journals' | 'accountBalances' | 'closeRuns' | 'dateCorrections' | 'consolidationAdjustments' | 'auditTrailExports',
  number
>;

/** The periods cannot be rebuilt: something already refers to them. A 4xx, nothing was written. */
export class FiscalPeriodsInUseError extends Error {
  readonly references: FiscalPeriodReferences;

  constructor(references: FiscalPeriodReferences) {
    const used = Object.entries(references).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', ');
    super(
      `The financial year cannot be changed: this company's fiscal periods are already in use (${used}). `
      + 'Delete its draft journals first, or use a guided change of year end.',
    );
    this.name = 'FiscalPeriodsInUseError';
    this.references = references;
  }
}

/** The company has posted journals, so its financial year start is fixed. A 4xx, nothing was written. */
export class FinancialYearStartLockedError extends Error {
  constructor(readonly postedJournals: number) {
    super(
      `The financial year start cannot be changed after the first posting (${postedJournals} posted journal(s)). `
      + 'Changing the financial year end needs a guided change of year end.',
    );
    this.name = 'FinancialYearStartLockedError';
  }
}

/** The requested start month is not a month. */
export class InvalidFinancialYearStartError extends Error {
  constructor(raw: unknown) {
    super(`financialYearStart must be a month 1-12, got ${JSON.stringify(raw)}`);
    this.name = 'InvalidFinancialYearStartError';
  }
}

/**
 * The change targets a company other than the request's active one. The
 * rebuilt periods are written under RLS WITH CHECK company_id =
 * app.current_company_id(), which is the active company.
 */
export class FinancialYearStartScopeError extends Error {
  constructor() {
    super('Switch to this company before changing its financial year start.');
    this.name = 'FinancialYearStartScopeError';
  }
}

/** Posted (or since reversed) journals: once there is one, the financial year start is locked. */
export async function countPostedJournals(companyId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS n FROM gl_journal_entries
     WHERE company_id = ${companyId}::UUID AND status <> 'draft'
  `) as DbRow[];
  return Number(rows[0]!.n);
}

/** Everything that would stop this company's periods being deleted and re-created. */
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
      (SELECT COUNT(*) FROM audit_trail_exports WHERE fiscal_period_id IN (SELECT id FROM p))::int AS audit_trail_exports
  `) as DbRow[];
  const r = rows[0]!;
  return {
    journals: Number(r.journals),
    accountBalances: Number(r.account_balances),
    closeRuns: Number(r.close_runs),
    dateCorrections: Number(r.date_corrections),
    consolidationAdjustments: Number(r.consolidation_adjustments),
    auditTrailExports: Number(r.audit_trail_exports),
  };
}

const inUse = (refs: FiscalPeriodReferences) => Object.values(refs).some((n) => n > 0);

/**
 * Replace every fiscal period of the company with the twelve of the fiscal year
 * containing `today`, built from `companies.financial_year_start`. Refuses
 * (FiscalPeriodsInUseError) when anything refers to the existing periods.
 *
 * Request transaction only: the DELETE and createFiscalYear's INSERTs must
 * commit or roll back together, and outside a request each `sql` autocommits.
 * Later years come from ensureFiscalPeriodForDate, which follows this layout.
 */
export async function rebuildUnusedFiscalPeriods(companyId: string, today: Date = new Date()): Promise<FiscalPeriod[]> {
  if (!als.getStore()?.client) {
    throw new Error('rebuildUnusedFiscalPeriods must run inside the request transaction');
  }
  const refs = await countFiscalPeriodReferences(companyId);
  if (inUse(refs)) throw new FiscalPeriodsInUseError(refs);

  await sql`DELETE FROM fiscal_periods WHERE company_id = ${companyId}::UUID`;
  // No periods now, so the alignment is the declared start month.
  const { startMonth } = await resolveCompanyPeriodAlignment(companyId);
  const fiscalYear = fiscalYearOfDate(today, startMonth);
  const periods = await createFiscalYear(companyId, fiscalYear);
  log.info('Rebuilt fiscal periods from the financial year start', { companyId, startMonth, fiscalYear }, 'accounting');
  return periods;
}

/**
 * Called before a company row's financial_year_start is written. Returns true
 * when the value really changes (the caller then rebuilds the periods after
 * its UPDATE), false when it is absent or the same. Throws, before anything is
 * written, when the change is not allowed: an invalid month, a company that is
 * not the request's active one, a posted journal (FinancialYearStartLockedError),
 * or periods otherwise in use (FiscalPeriodsInUseError). Locks the company row
 * so two changes serialise. A write before this check must not be committed by
 * the caller's 4xx (withAuth commits below 500), so callers run it first.
 */
export async function assertFinancialYearStartChange(companyId: string, requested: unknown): Promise<boolean> {
  if (requested === undefined || requested === null || requested === '') return false;
  const month = Number(requested);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new InvalidFinancialYearStartError(requested);

  const rows = (await sql`
    SELECT financial_year_start FROM companies WHERE id = ${companyId}::UUID FOR UPDATE
  `) as DbRow[];
  if (rows.length === 0) return false; // the UPDATE finds nothing either; the caller reports it
  if (Number(rows[0]!.financial_year_start) === month) return false;
  if (als.getStore()?.companyId !== companyId) throw new FinancialYearStartScopeError();

  const posted = await countPostedJournals(companyId);
  if (posted > 0) throw new FinancialYearStartLockedError(posted);
  const refs = await countFiscalPeriodReferences(companyId);
  if (inUse(refs)) throw new FiscalPeriodsInUseError(refs);
  return true;
}
