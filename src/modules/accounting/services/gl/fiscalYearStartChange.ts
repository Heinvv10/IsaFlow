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
 *   - companyService.updateCompany: a change of financial_year_start is allowed
 *     only before the first posting and then rebuilds the periods the same way;
 *     after it, the change is refused. A save of the SAME month on a company
 *     whose periods start elsewhere repairs them when nothing uses them
 *     (assertFinancialYearStartChange).
 *
 * THE GUARD is the census in fiscalPeriodReferences.ts, not the FKs: close_runs
 * CASCADEs, two tables have no FK, and year-numbered rows have no FK at all.
 */

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { FiscalPeriod } from '../../types/gl.types';
import { createFiscalYear, resolveCompanyPeriodAlignment } from './fiscalYearCreateService';
import { fiscalYearOfDate, normaliseStartMonth } from './fiscalYearCalendar';
import { countFiscalPeriodReferences, periodsInUse, type FiscalPeriodReferences } from './fiscalPeriodReferences';

export { countFiscalPeriodReferences, NO_REFERENCES, type FiscalPeriodReferences } from './fiscalPeriodReferences';

/** True today: the guided change of year end is being built, not shipped. */
const YEAR_END_CHANGE = 'Changing the financial year end will be possible through a guided change of year end '
  + '(coming soon); contact support if you need it now.';

/** The periods cannot be rebuilt: something already uses them. A 409, nothing was written. */
export class FiscalPeriodsInUseError extends Error {
  readonly references: FiscalPeriodReferences;

  constructor(references: FiscalPeriodReferences) {
    const used = Object.entries(references).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', ');
    super(
      `The financial year start cannot be changed: this company's fiscal periods are already in use (${used}). `
      + `If these are draft journals, delete them first. ${YEAR_END_CHANGE}`,
    );
    this.name = 'FiscalPeriodsInUseError';
    this.references = references;
  }
}

/** The company has posted journals, so its financial year start is fixed. A 409, nothing was written. */
export class FinancialYearStartLockedError extends Error {
  constructor(readonly postedJournals: number) {
    super(`The financial year start cannot be changed after the first posting (${postedJournals} posted journal(s)). `
      + YEAR_END_CHANGE);
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

interface StartMonths {
  /** companies.financial_year_start, normalised (NULL and 0 are March), as every reader takes it. */
  declared: number;
  /** The month period 1 of the latest fiscal year starts in (resolveCompanyPeriodAlignment's reading); null: no periods. */
  actual: number | null;
}

async function readStartMonths(companyId: string, lock: boolean): Promise<StartMonths | null> {
  const rows = (lock
    ? await sql`SELECT financial_year_start FROM companies WHERE id = ${companyId}::UUID FOR UPDATE`
    : await sql`SELECT financial_year_start FROM companies WHERE id = ${companyId}::UUID`) as DbRow[];
  if (rows.length === 0) return null;
  const p1 = (await sql`
    SELECT EXTRACT(MONTH FROM start_date)::int AS m FROM fiscal_periods
     WHERE company_id = ${companyId}::UUID AND period_number = 1
     ORDER BY fiscal_year DESC LIMIT 1
  `) as DbRow[];
  return { declared: normaliseStartMonth(rows[0]!.financial_year_start), actual: p1[0] ? Number(p1[0].m) : null };
}

/**
 * What Settings shows for the financial year start of the company it is
 * viewing. Counted only for the request's ACTIVE company: for another one (a
 * super_admin viewing a tenant) RLS would scope the counts to the active
 * company and could report "unlocked", and the PUT refuses a change there
 * anyway, so the view is read-only and the actual month is not claimed.
 */
export async function financialYearStartView(companyId: string, activeCompanyId: string | undefined): Promise<{
  financialYearStartLocked: boolean;
  financialYearStartLockReason: 'posted' | 'not_active' | null;
  financialYearStartActual: number | null;
}> {
  if (companyId !== activeCompanyId) {
    return { financialYearStartLocked: true, financialYearStartLockReason: 'not_active', financialYearStartActual: null };
  }
  const posted = (await countPostedJournals(companyId)) > 0;
  const months = await readStartMonths(companyId, false);
  return {
    financialYearStartLocked: posted,
    financialYearStartLockReason: posted ? 'posted' : null,
    financialYearStartActual: months?.actual ?? null,
  };
}

/**
 * Replace every fiscal period of the company with the twelve of the fiscal year
 * containing `today`, built from `companies.financial_year_start`. Refuses
 * (FiscalPeriodsInUseError) when anything uses the existing periods. Any
 * pre-created later year (the seeder writes next year too) goes with them;
 * ensureFiscalPeriodForDate recreates a year on demand, on this layout.
 *
 * Request transaction only: the DELETE and createFiscalYear's INSERTs must
 * commit or roll back together, and outside a request each `sql` autocommits.
 */
export async function rebuildUnusedFiscalPeriods(companyId: string, today: Date = new Date()): Promise<FiscalPeriod[]> {
  if (!als.getStore()?.client) {
    throw new Error('rebuildUnusedFiscalPeriods must run inside the request transaction');
  }
  const refs = await countFiscalPeriodReferences(companyId);
  if (periodsInUse(refs)) throw new FiscalPeriodsInUseError(refs);

  await sql`DELETE FROM fiscal_periods WHERE company_id = ${companyId}::UUID`;
  // No periods now, so the alignment is the declared start month.
  const { startMonth } = await resolveCompanyPeriodAlignment(companyId);
  const fiscalYear = fiscalYearOfDate(today, startMonth);
  const periods = await createFiscalYear(companyId, fiscalYear);
  log.info('Rebuilt fiscal periods from the financial year start', { companyId, startMonth, fiscalYear }, 'accounting');
  return periods;
}

/** A different month (a change), or the same month over periods that start elsewhere (a repair). */
const decide = (m: StartMonths, month: number) => ({
  changes: m.declared !== month,
  repairs: m.declared === month && m.actual !== null && m.actual !== month,
});

/**
 * Called before a company row's financial_year_start is written. Returns true
 * when the caller must rebuild the periods after its UPDATE.
 *
 * - Absent, or the same month over periods that already start on it: false,
 *   WITHOUT a row lock. Every settings save sends the month, and a FOR UPDATE
 *   on companies would stall every FK insert on the company (journals,
 *   invoices) until the request commits.
 * - A change: refused before anything is written (a caller's 4xx still
 *   commits, so it runs first) for an invalid month, a company other than the
 *   active one, a posted journal (FinancialYearStartLockedError) or periods
 *   otherwise in use (FiscalPeriodsInUseError). Otherwise true, holding
 *   FOR UPDATE on the company row from before the counts to the commit: an FK
 *   insert (a close run, a journal) cannot land between the count and the rebuild.
 * - A repair (same month, periods elsewhere): true under the same lock when
 *   nothing uses the periods, else false. Never refuses a save.
 */
export async function assertFinancialYearStartChange(companyId: string, requested: unknown): Promise<boolean> {
  if (requested === undefined || requested === null || requested === '') return false;
  const month = Number(requested);
  if (!Number.isInteger(month) || month < 1 || month > 12) throw new InvalidFinancialYearStartError(requested);

  const unlocked = await readStartMonths(companyId, false);
  if (!unlocked) return false; // the UPDATE finds nothing either; the caller reports it
  const first = decide(unlocked, month);
  if (!first.changes && !first.repairs) return false;
  if (als.getStore()?.companyId !== companyId) {
    if (first.changes) throw new FinancialYearStartScopeError();
    return false;
  }
  // A repair is opportunistic: when the periods are visibly in use, skip it without locking.
  if (first.repairs && ((await countPostedJournals(companyId)) > 0 || periodsInUse(await countFiscalPeriodReferences(companyId)))) {
    return false;
  }

  // Lock, then decide again on what the lock now protects.
  const locked = await readStartMonths(companyId, true);
  if (!locked) return false;
  const { changes, repairs } = decide(locked, month);
  if (!changes && !repairs) return false;
  const posted = await countPostedJournals(companyId);
  if (posted > 0) {
    if (changes) throw new FinancialYearStartLockedError(posted);
    return false;
  }
  const refs = await countFiscalPeriodReferences(companyId);
  if (periodsInUse(refs)) {
    if (changes) throw new FiscalPeriodsInUseError(refs);
    return false;
  }
  return true;
}
