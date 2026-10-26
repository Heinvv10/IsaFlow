/**
 * The budget grid's read model (P2 spec 4.2): one version of one financial year with its months,
 * accounts, dimension members, cells, grains and live band totals. Reads only; the writer is
 * gridSave. Every query is scoped by company_id.
 *
 * Which version: a named `versionId` (another tenant's is BUDGET_VERSION_NOT_FOUND), else the
 * year's primary, else its newest; a year with no version answers `version: null`.
 * The token (`updatedAt`) is P1's text form of updated_at (UTC ISO, microseconds, the same as `version.updatedAt`),
 * which the status route's TIMESTAMP check accepts, so one token chains read -> save -> status (spec 7.1).
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { requireFiscalYear } from '../gl/fiscalYearRegistry';
import { toBudgetYearInfo, type BudgetYearInfo } from '../core/budgetYears';
import { monthKeyToDate } from '../reports/budgetPeriodWindow';
import { BudgetVersionError } from './budgetVersionTypes';
import { getVersion } from './budgetVersions';
import { fromCents, toCents } from './grid/cents';
import { cellKey, type CellKey } from './grid/cellKey';
import { accountGrains, type AccountGrain } from './grid/pivot';
import { foldBands, type BandTotals, type Metric } from './grid/subtotals';
import { loadGridAccounts, loadGridDimensions } from './gridReadAccounts';
import type { GridCell, GridCellsOnly, GridReadModel, GridSelector } from './gridReadTypes';

interface Resolved { id: string; fiscalYear: number; token: string }

async function resolveVersion(companyId: string, sel: GridSelector): Promise<Resolved | null> {
  const rows = (sel.versionId !== undefined
    ? await sql`
        SELECT id, fiscal_year, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS token FROM budget_versions
         WHERE id = ${sel.versionId}::UUID AND company_id = ${companyId}::UUID`
    : sel.fiscalYear !== undefined
      ? await sql`
        SELECT id, fiscal_year, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS token FROM budget_versions
         WHERE company_id = ${companyId}::UUID AND fiscal_year = ${sel.fiscalYear}
         ORDER BY is_primary DESC, created_at DESC, id DESC
         LIMIT 1`
      : null) as DbRow[] | null;
  if (rows === null) throw new BudgetVersionError('BUDGET_VERSION_INPUT', 'Name a version or a financial year');
  if (!rows[0]) {
    if (sel.versionId !== undefined) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
    return null;
  }
  return { id: String(rows[0].id), fiscalYear: Number(rows[0].fiscal_year), token: String(rows[0].token) };
}

async function yearOf(companyId: string, label: number): Promise<BudgetYearInfo> {
  const year = toBudgetYearInfo(await requireFiscalYear(companyId, label));
  if (year.monthKeys.length === 0) throw new BudgetVersionError('BUDGET_VERSION_STATE', `Financial year ${label} has no months`);
  return year;
}

/** The version's cells inside the year's months, on revenue/expense accounts, in a stable order. */
async function readCells(companyId: string, versionId: string, year: BudgetYearInfo): Promise<GridCell[]> {
  const first = monthKeyToDate(year.monthKeys[0]!);
  const last = monthKeyToDate(year.monthKeys[year.monthKeys.length - 1]!);
  const rows = (await sql`
    SELECT bm.gl_account_id, bm.cc1_id, bm.cc2_id, bm.bu_id, to_char(bm.month, 'YYYY-MM') AS month, bm.amount::text AS amount
      FROM budget_month_amounts bm
      JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
     WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
       AND bm.month BETWEEN ${first}::DATE AND ${last}::DATE
       AND ga.account_type IN ('revenue', 'expense')
     ORDER BY ga.account_code, bm.gl_account_id, bm.month, bm.cc1_id NULLS FIRST, bm.cc2_id NULLS FIRST, bm.bu_id NULLS FIRST
  `) as DbRow[];
  const id = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  return rows.map((r) => ({
    glAccountId: String(r.gl_account_id), cc1Id: id(r.cc1_id), cc2Id: id(r.cc2_id), buId: id(r.bu_id),
    month: String(r.month), amount: Number(r.amount),
  }));
}

/** The compare-version fetch (`cells_only=1`): the cells and the token, nothing else. */
export async function loadGridCells(companyId: string, sel: GridSelector): Promise<GridCellsOnly> {
  const found = await resolveVersion(companyId, sel);
  if (!found) return { versionId: null, updatedAt: null, cells: [] };
  const year = await yearOf(companyId, found.fiscalYear);
  return { versionId: found.id, updatedAt: found.token, cells: await readCells(companyId, found.id, year) };
}

const rand = (cents: number[]): number[] => cents.map(fromCents);

function randTotals(t: BandTotals): BandTotals {
  const months = Object.fromEntries(Object.entries(t.months).map(([k, v]) => [k, rand(v)])) as Record<Metric, number[]>;
  const fy = Object.fromEntries(Object.entries(t.fy).map(([k, v]) => [k, fromCents(v)])) as Record<Metric, number>;
  return { months, fy };
}

export async function loadGridReadModel(companyId: string, sel: GridSelector): Promise<GridReadModel> {
  const found = await resolveVersion(companyId, sel);
  const label = found?.fiscalYear ?? sel.fiscalYear;
  if (label === undefined) throw new BudgetVersionError('BUDGET_VERSION_INPUT', 'Name a version or a financial year');
  const year = await yearOf(companyId, label);
  const monthCount = year.monthKeys.length;
  const emptyDims = { cc1: [], cc2: [], bu: [] };
  if (!found) {
    return {
      version: null, updatedAt: null, year, accounts: [], dimensions: await loadGridDimensions(companyId, emptyDims), cells: [], grains: {},
      totals: randTotals(foldBands([], () => [], monthCount)),
    };
  }

  const version = await getVersion(companyId, found.id);
  const cells = await readCells(companyId, found.id, year);

  const monthIndex = new Map(year.monthKeys.map((m, i) => [m, i]));
  const cents = new Map<CellKey, number | null>();
  const own = new Map<string, number[]>();
  const used = { cc1: new Set<string>(), cc2: new Set<string>(), bu: new Set<string>() };
  for (const c of cells) {
    const v = toCents(c.amount);
    cents.set(cellKey({ glAccountId: c.glAccountId, cc1Id: c.cc1Id, cc2Id: c.cc2Id, buId: c.buId, month: c.month }), v);
    const months = own.get(c.glAccountId) ?? Array<number>(monthCount).fill(0);
    const i = monthIndex.get(c.month)!;
    months[i] = (months[i] ?? 0) + v;
    own.set(c.glAccountId, months);
    if (c.cc1Id) used.cc1.add(c.cc1Id);
    if (c.cc2Id) used.cc2.add(c.cc2Id);
    if (c.buId) used.bu.add(c.buId);
  }
  const grains: Map<string, AccountGrain> = accountGrains(cents);
  const accounts = await loadGridAccounts(companyId, own, grains, monthCount);
  const dimensions = await loadGridDimensions(companyId, { cc1: [...used.cc1], cc2: [...used.cc2], bu: [...used.bu] });

  // Lines and a legacy header's OWN amounts, once each: a header's roll-up is display only.
  const counted = accounts.filter((a) => !a.isHeader || a.ownAmounts);
  const totals = randTotals(foldBands(counted, (a) => own.get(a.id) ?? [], monthCount));

  return { version, updatedAt: found.token, year, accounts, dimensions, cells, grains: Object.fromEntries(grains), totals };
}
