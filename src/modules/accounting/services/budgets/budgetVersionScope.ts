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
import { addMonthsToKey, budgetMonthBounds, monthEnd, monthKeyToDate } from '../reports/budgetPeriodWindow';
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

type Part = { fiscalYear: number; first: string; last: string };

function clip(year: FiscalYearRecord, first: string, last: string, handsOnLast: boolean): { first: string; last: string } | null {
  const own = budgetMonthBounds(year.startDate, year.endDate);
  if (!own) return null;
  const ownLast = handsOnLast ? monthKeyToDate(addMonthsToKey(own.last.slice(0, 7), -1)) : own.last;
  const f = own.first > first ? own.first : first;
  const l = ownLast < last ? ownLast : last;
  return f <= l ? { first: f, last: l } : null;
}

/** The STORED registry year holding `date` (no template year, never an error): null in a gap, before the first or after the last. */
async function storedYearHolding(companyId: string, date: string): Promise<number | null> {
  const rows = (await sql`
    SELECT fiscal_year FROM fiscal_years
     WHERE company_id = ${companyId}::UUID AND start_date <= ${date}::DATE AND end_date >= ${date}::DATE
  `) as DbRow[];
  return rows[0] ? Number(rows[0].fiscal_year) : null;
}

/**
 * The registry years overlapping [startDate, endDate], each with its months inside the window.
 *
 * Owner rule (ledger LB-2(b)): a month two years share (one ends and the next starts inside it)
 * counts once. Between two STORED years it is the year holding its 1st, the key a change of year end
 * files a month under (`budgetYearRehome`, `fiscalYearForDate(month)`), whatever day the window starts.
 * When the 1st lies in a template year and the month's later part in a stored year, it is the stored
 * year's. Otherwise (template to template, a gap, a template to a gap) master's attribution holds:
 * the year of the window's first day, then each following year from its first whole month.
 *
 * The walk is master's: from the window's first DAY to the day after each year ends. Two steps apply
 * the rule where that walk alone would not, both only where a year starts mid-month:
 *   - The window starts in a year that starts mid-month inside the window's first month: the first
 *     month goes to the stored year holding its 1st, if there is one (`storedYearHolding`).
 *   - A template year ending mid-month keeps none of its last month ONLY when the day after it ends
 *     is in a stored year (`storedYearHolding`); the walk goes on to that stored year for it even past
 *     the window's end, so the owed lookup always lands on a stored year (never a gap).
 *
 * `visited` is every registry year the walk touched by DATE, the year holding the first day always
 * first (even for an inverted window), never empty: one lookup per year, shared with the callers that
 * need the years themselves (`primaryVersionScopeAndYears`), so no read walks the registry twice. Its
 * years and the parts' differ where a year owns no month in the window or owns one it is not touched in.
 */
async function yearsInWindow(companyId: string, startDate: string, endDate: string) {
  const bounds = budgetMonthBounds(startDate, endDate);
  const parts: Part[] = [];
  const visited: FiscalYearRecord[] = [];
  let day = startDate;
  let first = bounds?.first ?? startDate;
  let lookups = 0;
  // An inverted window owns no month. Otherwise a month a template year handed on is owed while
  // `first` is inside the window, so the walk goes on past the window's end for it.
  const owes = (): boolean => bounds !== null && endDate >= startDate && first <= bounds.last;
  while (visited.length === 0 || day <= endDate || owes()) {
    if (visited.length >= MAX_YEARS_IN_WINDOW || lookups >= 2 * MAX_YEARS_IN_WINDOW) {
      throw new Error(`budget window ${startDate}..${endDate} spans too many years`);
    }
    lookups += 1;
    const year = await fiscalYearForDate(companyId, day);
    if (day <= endDate || visited.length === 0) visited.push(year);
    const part = owes() ? clip(year, first, bounds!.last, await handsOnLastMonth(companyId, year)) : null;
    if (part) {
      parts.push({ fiscalYear: year.fiscalYear, ...part });
      first = monthKeyToDate(addMonthsToKey(part.last.slice(0, 7), 1));
    }
    day = dayAfter(year.endDate);
  }
  if (visited.length === 0) throw new Error(`budget window ${startDate}..${endDate} touched no registry year`);
  await giveFirstMonthToItsOwner(companyId, visited[0]!, parts, bounds?.first ?? null);
  return { parts, visited };
}

/** A template year ending mid-month gives its last month to the year after only when that year is stored. */
async function handsOnLastMonth(companyId: string, year: FiscalYearRecord): Promise<boolean> {
  if (year.stored || year.endDate === monthEnd(year.endDate)) return false;
  return (await storedYearHolding(companyId, dayAfter(year.endDate))) !== null;
}

/**
 * The window starts in a year that starts mid-month inside its first month: that month belongs to the
 * stored year holding its 1st, when there is one. Only such a registry pays the extra lookup.
 */
async function giveFirstMonthToItsOwner(companyId: string, startYear: FiscalYearRecord, parts: Part[], firstMonth: string | null) {
  const head = parts[0];
  if (!firstMonth || !head || head.first !== firstMonth || startYear.startDate <= firstMonth) return;
  const owner = await storedYearHolding(companyId, firstMonth);
  if (owner === null || owner === head.fiscalYear) return;
  if (head.last === firstMonth) parts.shift();
  else head.first = monthKeyToDate(addMonthsToKey(firstMonth.slice(0, 7), 1));
  parts.unshift({ fiscalYear: owner, first: firstMonth, last: firstMonth });
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
  const labels = parts.map((y) => y.fiscalYear);
  const prim = (await sql`
    SELECT id, fiscal_year FROM budget_versions
     WHERE company_id = ${companyId}::UUID AND is_primary AND fiscal_year = ANY(${labels}::INT[])
  `) as DbRow[];
  const byLabel = new Map(prim.map((r) => [Number(r.fiscal_year), String(r.id)]));
  return {
    scope: parts.map((y) => ({ fiscalYear: y.fiscalYear, versionId: byLabel.get(y.fiscalYear) ?? null, first: y.first, last: y.last })),
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
