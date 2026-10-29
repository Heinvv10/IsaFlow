/**
 * Which budget version a read or write uses (migration 947).
 *
 * Readers use the PRIMARY version of each registry year unless a version is named, and a version
 * counts only the months inside its own financial year: a window across two years takes each
 * year's primary for that year's months. Writers lock the version row FIRST
 * (`lockVersionForWrite`): it serialises writers of one version (the upgrade-deadlock rule, spec
 * §3.5) and turns "locked" into a typed 409 before any amount is written, so the request
 * transaction is never poisoned by the lock trigger, which stays as the backstop.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { RowLockTimeoutError, withRowLockBudget } from '../core/rowLockBudget';
import { fiscalYearForDate, getFiscalYear, type FiscalYearRecord } from '../gl/fiscalYearRegistry';
import { addDaysISO } from '@/lib/dateUtils';
import { addMonthsToKey, budgetMonthBounds, monthKeyToDate } from '../reports/budgetPeriodWindow';
import { logAuditOrThrow, type AuditAction } from '../core/auditTrailService';
import { BudgetVersionError } from './budgetVersionTypes';

/** One version and the first-of-month dates it contributes, both ends inclusive. */
export interface VersionScope {
  fiscalYear: number;
  /** Null: the year has no primary version, so it contributes nothing. */
  versionId: string | null;
  first: string;
  last: string;
}

/** A window longer than this many financial years is a caller bug, not a report. */
const MAX_YEARS_IN_WINDOW = 200;

const dayAfter = (date: string): string => addDaysISO(date, 1);

/**
 * Holds the company's financial-year registry steady for this transaction: the SHARED form of the
 * advisory lock a change of year end (and its undo) takes exclusively. A budget writer takes it
 * BEFORE it reads the registry, so a save and a year-end change run one after the other and the
 * change's re-home of budget months sees every committed row (no save filed under the old years).
 * Bounded like every row-lock wait (503 on timeout).
 */
export async function holdYearRegistry(companyId: string): Promise<void> {
  await withRowLockBudget(
    () => sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`fy-end-change:${companyId}`}, 0))`,
    () => new RowLockTimeoutError('The financial years'),
  );
}

/** The year's primary version id; with `create`, a draft primary 'Original' when it has none. */
export async function resolvePrimaryVersion(
  companyId: string,
  fiscalYear: number,
  opts: { create: boolean; actor?: string } = { create: false },
): Promise<string | null> {
  const found = (await sql`
    SELECT id FROM budget_versions WHERE company_id = ${companyId}::UUID AND fiscal_year = ${fiscalYear} AND is_primary
  `) as DbRow[];
  if (found[0]) return String(found[0].id);
  if (!opts.create) return null;
  if (!opts.actor) throw new Error('resolvePrimaryVersion: creating a version needs an actor');
  // Any unique clash (a concurrent creator, or a version already named 'Original') does nothing.
  await sql`
    INSERT INTO budget_versions (company_id, fiscal_year, name, kind, is_primary, created_by)
    VALUES (${companyId}::UUID, ${fiscalYear}, 'Original', 'original', true, ${opts.actor})
    ON CONFLICT DO NOTHING
  `;
  const made = (await sql`
    SELECT id FROM budget_versions WHERE company_id = ${companyId}::UUID AND fiscal_year = ${fiscalYear} AND is_primary
  `) as DbRow[];
  if (!made[0]) {
    throw new BudgetVersionError('BUDGET_VERSION_STATE',
      `FY${fiscalYear} has no primary budget version and one named 'Original' already exists: set a primary version first`);
  }
  return String(made[0].id);
}

/**
 * Locks the version row for this transaction (bounded wait) and bumps its updated_at. A locked
 * version is BUDGET_VERSION_LOCKED and one that is not the company's BUDGET_VERSION_NOT_FOUND,
 * both before anything is written. Returns the version's fiscal-year label.
 */
export async function lockVersionForWrite(companyId: string, versionId: string): Promise<{ fiscalYear: number; isPrimary: boolean }> {
  const rows = (await withRowLockBudget(
    () => sql`
      UPDATE budget_versions SET updated_at = clock_timestamp()
       WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID AND status <> 'locked'
      RETURNING fiscal_year, is_primary
    `,
    () => new RowLockTimeoutError('This budget version'),
  )) as DbRow[];
  if (rows[0]) return { fiscalYear: Number(rows[0].fiscal_year), isPrimary: Boolean(rows[0].is_primary) };
  const exists = (await sql`
    SELECT status FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (exists[0]) throw new BudgetVersionError('BUDGET_VERSION_LOCKED', 'This budget version is locked');
  throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
}

/** The registry year a version belongs to, refusing another company's version (404). */
export async function versionYear(companyId: string, versionId: string): Promise<FiscalYearRecord> {
  const rows = (await sql`
    SELECT fiscal_year FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID
  `) as DbRow[];
  if (!rows[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  const year = await getFiscalYear(companyId, Number(rows[0].fiscal_year));
  if (!year) throw new BudgetVersionError('BUDGET_VERSION_STATE', `No financial year is labelled ${String(rows[0].fiscal_year)}`);
  return year;
}

function clip(year: FiscalYearRecord, first: string, last: string): { first: string; last: string } | null {
  const own = budgetMonthBounds(year.startDate, year.endDate);
  if (!own) return null;
  const f = own.first > first ? own.first : first;
  const l = own.last < last ? own.last : last;
  return f <= l ? { first: f, last: l } : null;
}

/**
 * The registry years overlapping [startDate, endDate], each with its months inside the window. The
 * walk starts at the window's first DAY and steps to the day after each year ends, so a year that
 * starts mid-month keeps its first month (as the budgets page writes it). A month two years share
 * (one ends and the next starts inside it) counts once, in the earlier year of the window.
 *
 * `visited` is every registry year the walk touched by DATE, the year holding the first day always
 * first (even for an inverted window): one lookup per year, shared with the callers that need the
 * years themselves (`primaryVersionScopeAndYears`), so no read walks the registry twice. It is longer
 * than the parts when a year starts mid-month inside the window's last month and so owns no month.
 */
async function yearsInWindow(companyId: string, startDate: string, endDate: string) {
  const bounds = budgetMonthBounds(startDate, endDate);
  const parts: Array<{ year: FiscalYearRecord; first: string; last: string }> = [];
  const visited: FiscalYearRecord[] = [];
  let day = startDate;
  let first = bounds?.first ?? startDate;
  while (visited.length === 0 || day <= endDate) {
    if (visited.length >= MAX_YEARS_IN_WINDOW) throw new Error(`budget window ${startDate}..${endDate} spans too many years`);
    const year = await fiscalYearForDate(companyId, day);
    visited.push(year);
    const part = bounds && day <= endDate && first <= bounds.last ? clip(year, first, bounds.last) : null;
    if (part) {
      parts.push({ year, ...part });
      first = monthKeyToDate(addMonthsToKey(part.last.slice(0, 7), 1));
    }
    day = dayAfter(year.endDate);
  }
  return { parts, visited };
}

/**
 * Each registry year overlapping the window with its primary version (or null) and its months in the window
 * (`scope`), and the registry years the window touches by date (`years`, see `yearsInWindow`), from ONE walk.
 */
export async function primaryVersionScopeAndYears(
  companyId: string, startDate: string, endDate: string,
): Promise<{ scope: VersionScope[]; years: FiscalYearRecord[] }> {
  const { parts, visited } = await yearsInWindow(companyId, startDate, endDate);
  if (parts.length === 0) return { scope: [], years: visited };
  const labels = parts.map((y) => y.year.fiscalYear);
  const prim = (await sql`
    SELECT id, fiscal_year FROM budget_versions
     WHERE company_id = ${companyId}::UUID AND is_primary AND fiscal_year = ANY(${labels}::INT[])
  `) as DbRow[];
  const byLabel = new Map(prim.map((r) => [Number(r.fiscal_year), String(r.id)]));
  return {
    scope: parts.map((y) => ({ fiscalYear: y.year.fiscalYear, versionId: byLabel.get(y.year.fiscalYear) ?? null, first: y.first, last: y.last })),
    years: visited,
  };
}

/** The version a read of `fiscalYear` uses: the named one (which must be that year's) or the primary. */
export async function readVersion(companyId: string, fiscalYear: number, versionId?: string): Promise<string | null> {
  if (!versionId) return resolvePrimaryVersion(companyId, fiscalYear);
  if ((await versionYear(companyId, versionId)).fiscalYear !== fiscalYear) {
    throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', `Budget version not found in FY${fiscalYear}`);
  }
  return versionId;
}

export async function auditBudgetWrite(
  companyId: string, userId: string, action: AuditAction, versionId: string, fiscalYear: number, metadata: Record<string, string>,
): Promise<void> {
  await logAuditOrThrow({
    companyId, userId, action, entityType: 'budget', entityId: versionId, entityRef: `FY${fiscalYear} budget`,
    changes: { fields: [], metadata: { fiscalYear: String(fiscalYear), ...metadata } },
  });
}
