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
 *     after it, the change is refused (assertFinancialYearStartChange). A save
 *     of the same month is a no-op, even over periods that start elsewhere.
 *
 * THE GUARD is the census in fiscalPeriodReferences.ts, not the FKs: close_runs
 * CASCADEs, two tables have no FK, and year-numbered rows have no FK at all.
 */

import { als } from '@/lib/als';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { FiscalPeriod } from '../../types/gl.types';
import { mapFiscalPeriodRow } from './fiscalYearCreateService';
import { generateFiscalYearForDate } from './fiscalYearGenerator';
import { normaliseStartMonth } from './fiscalYearCalendar';
import { countFiscalPeriodReferences, periodsInUse, type FiscalPeriodReferences } from './fiscalPeriodReferences';
import { YEAR_END_CHANGE_MESSAGE } from './financialYearStartMessages';

export { countFiscalPeriodReferences, NO_REFERENCES, type FiscalPeriodReferences } from './fiscalPeriodReferences';


/** The periods cannot be rebuilt: something already uses them. A 409, nothing was written. */
export class FiscalPeriodsInUseError extends Error {
  readonly references: FiscalPeriodReferences;

  constructor(references: FiscalPeriodReferences) {
    const used = Object.entries(references).filter(([, n]) => n > 0).map(([k, n]) => `${k}: ${n}`).join(', ');
    super(
      `The financial year start cannot be changed: this company's fiscal periods are already in use (${used}). `
      + `If these are draft journals, delete them first. ${YEAR_END_CHANGE_MESSAGE}`,
    );
    this.name = 'FiscalPeriodsInUseError';
    this.references = references;
  }
}

/** The company has posted journals, so its financial year start is fixed. A 409, nothing was written. */
export class FinancialYearStartLockedError extends Error {
  constructor(readonly postedJournals: number) {
    super(`The financial year start cannot be changed after the first posting (${postedJournals} posted journal(s)). `
      + YEAR_END_CHANGE_MESSAGE);
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

/** companies.financial_year_start, normalised (NULL and 0 are March) as every reader takes it; null: no such company. */
async function readDeclaredStartMonth(companyId: string, lock: boolean): Promise<number | null> {
  const rows = (lock
    ? await sql`SELECT financial_year_start FROM companies WHERE id = ${companyId}::UUID FOR UPDATE`
    : await sql`SELECT financial_year_start FROM companies WHERE id = ${companyId}::UUID`) as DbRow[];
  return rows.length === 0 ? null : normaliseStartMonth(rows[0]!.financial_year_start);
}

/** The month period 1 of the latest fiscal year starts in (resolveCompanyPeriodAlignment's reading); null: no periods. */
async function readActualStartMonth(companyId: string): Promise<number | null> {
  const rows = (await sql`
    SELECT EXTRACT(MONTH FROM start_date)::int AS m FROM fiscal_periods
     WHERE company_id = ${companyId}::UUID AND period_number = 1
     ORDER BY fiscal_year DESC LIMIT 1
  `) as DbRow[];
  return rows[0] ? Number(rows[0].m) : null;
}

export type FinancialYearStartLock =
  | { reason: 'posted'; postedJournals: number }
  | { reason: 'in_use'; references: FiscalPeriodReferences }
  | null;

/**
 * Why the financial year start cannot change now, or null when it can: a
 * posted (or reversed) journal first, else periods otherwise in use. The ONE
 * predicate behind both the PUT's refusal (assertFinancialYearStartChange) and
 * the GET's read-only flag (financialYearStartView), so the two cannot drift.
 */
export async function financialYearStartLock(companyId: string): Promise<FinancialYearStartLock> {
  const postedJournals = await countPostedJournals(companyId);
  if (postedJournals > 0) return { reason: 'posted', postedJournals };
  const references = await countFiscalPeriodReferences(companyId);
  return periodsInUse(references) ? { reason: 'in_use', references } : null;
}

/**
 * What Settings shows for the financial year start of the company it is
 * viewing. Locked exactly when assertFinancialYearStartChange would refuse a
 * change (financialYearStartLock). Counted only for the request's ACTIVE company: for another one (a
 * super_admin viewing a tenant) RLS would scope the counts to the active
 * company and could report "unlocked", and the PUT refuses a change there
 * anyway, so the view is read-only and the actual month is not claimed.
 */
export async function financialYearStartView(companyId: string, activeCompanyId: string | undefined): Promise<{
  financialYearStartLocked: boolean;
  financialYearStartLockReason: 'posted' | 'in_use' | 'not_active' | null;
  financialYearStartActual: number | null;
}> {
  if (companyId !== activeCompanyId) {
    return { financialYearStartLocked: true, financialYearStartLockReason: 'not_active', financialYearStartActual: null };
  }
  // The PUT's own predicate (financialYearStartLock), so the field is never editable for a change the PUT would 409.
  const lock = await financialYearStartLock(companyId);
  return {
    financialYearStartLocked: lock !== null,
    financialYearStartLockReason: lock?.reason ?? null,
    financialYearStartActual: await readActualStartMonth(companyId),
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
  await sql`DELETE FROM fiscal_years WHERE company_id = ${companyId}::UUID`;
  // No years now, so the template is the declared start month.
  const { fiscalYearId } = await generateFiscalYearForDate(companyId, today);
  const rows = (await sql`
    SELECT * FROM fiscal_periods WHERE company_id = ${companyId}::UUID AND fiscal_year_id = ${fiscalYearId}::UUID
     ORDER BY start_date
  `) as DbRow[];
  log.info('Rebuilt fiscal periods from the financial year start', { companyId, fiscalYearId }, 'accounting');
  return rows.map(mapFiscalPeriodRow);
}

/**
 * Called before a company row's financial_year_start is written. Returns true
 * when the month really changes, and the caller must rebuild the periods after
 * its UPDATE.
 *
 * - Absent, or the same month (normalised: NULL and 0 are March): false, WITHOUT
 *   a row lock. Every settings save sends the month, and a FOR UPDATE on
 *   companies would stall every FK insert on the company (journals, invoices)
 *   until the request commits. The same month never touches the periods, even
 *   when they start in another month: realigning an existing company is a
 *   per-company decision (Hein, 2026-10-22), not a side effect of a save.
 * - A change: refused before anything is written (a caller's 4xx still
 *   commits, so it runs first) for an invalid month, a company other than the
 *   active one, a posted journal (FinancialYearStartLockedError) or periods
 *   otherwise in use (FiscalPeriodsInUseError). Otherwise true, holding
 *   FOR UPDATE on the company row from before the counts to the commit: an FK
 *   insert (a close run, a journal) cannot land between the count and the rebuild.
 */
export async function assertFinancialYearStartChange(companyId: string, requested: unknown): Promise<boolean> {
  if (requested === undefined || requested === null) return false;
  // A real integer only: Number() would read true as 1 and [6] as 6. The settings page sends a number.
  if (typeof requested !== 'number' || !Number.isInteger(requested) || requested < 1 || requested > 12) {
    throw new InvalidFinancialYearStartError(requested);
  }
  const month = requested;

  const unlocked = await readDeclaredStartMonth(companyId, false);
  if (unlocked === null || unlocked === month) return false; // no row: the UPDATE finds nothing either
  if (als.getStore()?.companyId !== companyId) throw new FinancialYearStartScopeError();

  // A start-month change rebuilds the year registry, as a change of year end does: take that change's
  // lock (exclusive), so a budget save (budgets/budgetVersionScope.holdYearRegistry, shared) either
  // commits first and its version counts below, or waits and re-reads the new years.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`fy-end-change:${companyId}`}, 0))`;
  // Lock, then decide again on what the lock now protects.
  const locked = await readDeclaredStartMonth(companyId, true);
  if (locked === null || locked === month) return false;
  const lock = await financialYearStartLock(companyId);
  if (lock?.reason === 'posted') throw new FinancialYearStartLockedError(lock.postedJournals);
  if (lock) throw new FiscalPeriodsInUseError(lock.references);
  return true;
}
