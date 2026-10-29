/**
 * What a reforecast from actuals and a rolling re-roll both read and write (Budgets P4 spec §5, §6):
 * the year's closed months, their actuals at every level (P3's `readTrackingActuals`, THE actuals
 * SQL, read four times: groupBy null / cc1 / cc2 / bu, converted to cents), the engine's plan over
 * a version model (`planReforecast`), and the write of the planned cells, ONLY those whose amount
 * or source differ, so an unchanged cell keeps its updated_at and xmin. company_id on every
 * statement; the caller holds the version lock.
 *
 * A month is closed when every fiscal period covering its days inside the year is closed or
 * locked (at least one period). Periods are matched by date, never by their label: a company's
 * legacy January-December period labels need not match its registry year (942), and a 14-month
 * transition year is simply a longer registry year.
 */
import { sql, type DbRow } from '@/lib/neon';
import { getFiscalYear, type FiscalYearRecord } from '../../gl/fiscalYearRegistry';
import { budgetMonthKeysInWindow, monthEnd, monthKeyToDate } from '../../reports/budgetPeriodWindow';
import { BudgetVersionError } from '../budgetVersionTypes';
import { grainOf, parseKey } from '../grid/cellKey';
import { fromCents, toCents } from '../grid/cents';
import { bandOf } from '../grid/subtotals';
import { NIL_UUID } from '../gridSaveValidate';
import { readTrackingActuals, type ActualRow } from '../tracking/trackingActualRead';
import type { TrackingGroupBy } from '../tracking/trackingTypes';
import { versionHeadcount } from './driverHeadcount';
import type { VersionModel } from './driverRecomputeService';
import { DriverRangeError, type Cell, type RowKey } from './driverTypes';
import { planReforecast, type ReforecastActual, type ReforecastActuals, type ReforecastResult } from './reforecast';

type Level = keyof ReforecastActuals;
const LEVELS: ReadonlyArray<[Level, TrackingGroupBy | null]> = [['company', null], ['cc1', 'cc1'], ['cc2', 'cc2'], ['bu', 'bu']];
type AccountMeta = Pick<ActualRow, 'accountId' | 'accountCode' | 'accountName' | 'accountType' | 'accountSubtype'>;

export interface ClosedActuals {
  actuals: ReforecastActuals;
  /** Every account an actual names (code, name, type, subtype). */
  accounts: Map<string, AccountMeta>;
}

/** An untagged actual the reforecast could not place (spec §5), in rand, for the result and the grid banner. */
export interface UnplacedActualLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** The dimension the account is budgeted by, which these actuals carry no member of. */
  level: 'cc1' | 'cc2' | 'bu';
  month: string;
  amount: number;
}

const later = (a: string, b: string) => (a > b ? a : b);
const earlier = (a: string, b: string) => (a < b ? a : b);

/** The version's registry year and its months (12, or 14 in a transition year), as `versionMonths` reads them. */
export async function reforecastYear(companyId: string, fiscalYear: number): Promise<{ year: FiscalYearRecord; months: string[] }> {
  const year = await getFiscalYear(companyId, fiscalYear);
  if (!year) throw new BudgetVersionError('BUDGET_VERSION_STATE', `No financial year is labelled ${fiscalYear}`);
  const months = budgetMonthKeysInWindow(year.startDate, year.endDate);
  if (months.length === 0) throw new BudgetVersionError('BUDGET_VERSION_STATE', `Financial year ${fiscalYear} has no months`);
  return { year, months };
}

/** The version months (of `year`) whose fiscal periods are all closed or locked. */
export async function closedMonthsOf(companyId: string, year: FiscalYearRecord, months: readonly string[]): Promise<string[]> {
  const periods = (await sql`
    SELECT to_char(start_date, 'YYYY-MM-DD') AS s, to_char(end_date, 'YYYY-MM-DD') AS e, status
      FROM fiscal_periods
     WHERE company_id = ${companyId}::UUID AND start_date <= ${year.endDate}::DATE AND end_date >= ${year.startDate}::DATE
  `) as DbRow[];
  return months.filter((m) => {
    const first = later(monthKeyToDate(m), year.startDate);
    const last = earlier(monthEnd(monthKeyToDate(m)), year.endDate);
    const covering = periods.filter((p) => String(p.s) <= last && String(p.e) >= first);
    return covering.length > 0 && covering.every((p) => p.status === 'closed' || p.status === 'locked');
  });
}

function cents(r: ActualRow): number {
  try {
    return toCents(r.amount);
  } catch (err) {
    if (!(err instanceof RangeError)) throw err;
    throw new DriverRangeError(`Actuals of ${r.accountCode} in ${r.month} exceed the budget range`, r.accountId, r.month);
  }
}

/** The closed months' actuals at every level, in cents and budget sign. Sequential: withAuth binds one client. */
export async function readClosedActuals(companyId: string, year: FiscalYearRecord, closed: readonly string[]): Promise<ClosedActuals> {
  const actuals: Record<Level, ReforecastActual[]> = { company: [], cc1: [], cc2: [], bu: [] };
  const accounts = new Map<string, AccountMeta>();
  if (closed.length === 0) return { actuals, accounts };
  const sorted = [...closed].sort();
  // An open month between two closed ones is read too; the planner takes closed months only.
  const start = later(monthKeyToDate(sorted[0]!), year.startDate);
  const end = earlier(monthEnd(monthKeyToDate(sorted[sorted.length - 1]!)), year.endDate);
  for (const [level, groupBy] of LEVELS) {
    for (const r of await readTrackingActuals(companyId, start, end, {}, groupBy)) {
      accounts.set(r.accountId, r);
      actuals[level].push({ accountId: r.accountId, month: r.month, memberId: groupBy ? r.memberId : null, amount: cents(r) });
    }
  }
  return { actuals, accounts };
}

/**
 * The plan for `model` (the source's rows, cells and EVERY driver) over the closed months; headcount
 * from `hiresVersionId`'s planned hires and payroll. Rows created for actuals are banded by their
 * account, as `loadVersionModel` bands the rest.
 */
export async function planOver(
  companyId: string, model: VersionModel, hiresVersionId: string, closed: readonly string[], read: ClosedActuals,
): Promise<ReforecastResult> {
  const heads = model.defs.some((d) => d.kind === 'per_head') ? await versionHeadcount(companyId, hiresVersionId, model.months) : null;
  const bands = new Map(model.rows.map((r) => [r.glAccountId, r.band]));
  return planReforecast({
    months: model.months, rows: model.rows, sourceCells: model.cells, actuals: read.actuals, closedMonths: new Set(closed),
    drivers: model.defs, rounding: 1,
    headcount: (scope, month) => heads?.(scope).get(month)?.total ?? 0,
    accountBand: (accountId) => {
      const known = bands.get(accountId);
      if (known) return known;
      const a = read.accounts.get(accountId);
      if (!a) throw new Error(`reforecast: no account details for actual on ${accountId}`);
      return bandOf(a.accountType, a.accountSubtype);
    },
  });
}

/** The plan's unplaced actuals, named (code, name, the dimension the account is budgeted by), in rand. */
export function describeUnplaced(plan: ReforecastResult, read: ClosedActuals): UnplacedActualLine[] {
  const level = new Map(plan.rows.map((r) => [r.glAccountId, grainOf(r)]));
  return plan.unplaced.map((u) => {
    const a = read.accounts.get(u.accountId);
    const g = level.get(u.accountId);
    return {
      accountId: u.accountId, accountCode: a?.accountCode ?? '', accountName: a?.accountName ?? '',
      level: g === 'cc1' || g === 'cc2' || g === 'bu' ? g : 'cc1', month: u.month, amount: fromCents(u.amount),
    };
  });
}

/**
 * Writes the planned cells: a new cell is inserted, an existing one updated ONLY when its amount or
 * source differs (`IS DISTINCT FROM`), so a re-roll of unchanged books writes nothing. Returns the
 * cells written.
 */
export async function writePlannedCells(
  companyId: string, versionId: string, userId: string, cells: ReadonlyMap<RowKey, readonly Cell[]>,
): Promise<number> {
  const flat = [...cells].flatMap(([key, list]) => list.map((c) => ({ ref: parseKey(`${key}|${c.month}`), c })));
  if (flat.length === 0) return 0;
  const a = flat.map((x) => x.ref.glAccountId);
  const c1 = flat.map((x) => x.ref.cc1Id ?? NIL_UUID);
  const c2 = flat.map((x) => x.ref.cc2Id ?? NIL_UUID);
  const b = flat.map((x) => x.ref.buId ?? NIL_UUID);
  const m = flat.map((x) => monthKeyToDate(x.c.month));
  const amounts = flat.map((x) => x.c.amount);
  const src = flat.map((x) => x.c.source);
  const rows = (await sql`
    WITH up AS (
      INSERT INTO budget_month_amounts AS bm (company_id, version_id, gl_account_id, cc1_id, cc2_id, bu_id, month, amount, amount_source, created_by)
      SELECT ${companyId}::UUID, ${versionId}::UUID, t.a, NULLIF(t.c1, ${NIL_UUID}::UUID), NULLIF(t.c2, ${NIL_UUID}::UUID),
             NULLIF(t.b, ${NIL_UUID}::UUID), t.m, t.cents::NUMERIC / 100, t.src, ${userId}
        FROM unnest(${a}::UUID[], ${c1}::UUID[], ${c2}::UUID[], ${b}::UUID[], ${m}::DATE[], ${amounts}::BIGINT[], ${src}::TEXT[])
             AS t(a, c1, c2, b, m, cents, src)
      ON CONFLICT ON CONSTRAINT budget_month_amounts_one_per_cell DO UPDATE
         SET amount = EXCLUDED.amount, amount_source = EXCLUDED.amount_source
       WHERE (bm.amount, bm.amount_source) IS DISTINCT FROM (EXCLUDED.amount, EXCLUDED.amount_source)
      RETURNING 1
    )
    SELECT COUNT(*)::int AS n FROM up
  `) as DbRow[];
  return Number(rows[0]?.n ?? 0);
}
