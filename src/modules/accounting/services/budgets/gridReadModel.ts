/**
 * The budget grid's read model (P2 spec 4.2): one version of one financial year with its months,
 * accounts, dimension members, cells, grains and live band totals. Reads only; the writer is
 * gridSave. Every query is scoped by company_id.
 *
 * Which version: a named `versionId` (another tenant's is BUDGET_VERSION_NOT_FOUND), else the
 * year's primary, else its newest; a year with no version answers `version: null`.
 * The token (`updatedAt`) is P1's text form of updated_at (UTC ISO, microseconds), which the status
 * route's TIMESTAMP check accepts, so one token chains read -> save -> status (spec 7.1). The token
 * and the cells come from ONE statement (one snapshot): they always describe the same state, so a
 * save landing during the read can neither let a stale edit through (a newer token over older
 * cells) nor make the import call a legitimate file tampered (an older token over newer cells,
 * VER-L2). The full model's `version.updatedAt` and `version.status` come from that statement too
 * (round 9), so a status move landing during the read never pairs one state's status with
 * another's token.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { requireFiscalYear } from '../gl/fiscalYearRegistry';
import { toBudgetYearInfo, type BudgetYearInfo } from '../core/budgetYears';
import { monthKeyToDate } from '../reports/budgetPeriodWindow';
import { BudgetVersionError, type BudgetVersion } from './budgetVersionTypes';
import { getVersion } from './budgetVersions';
import { toCents } from './grid/cents';
import { cellKey, type CellKey } from './grid/cellKey';
import { accountGrains, type AccountGrain } from './grid/pivot';
import { inputError, tokenSql } from './gridErrors';
import { loadGridAccounts, loadGridDimensions } from './gridReadAccounts';
import { bandTotals, ownMonths } from './gridTotals';
import type { GridCell, GridCellsOnly, GridReadModel, GridSelector } from './gridReadTypes';

interface Resolved { id: string; fiscalYear: number }

async function resolveVersion(companyId: string, sel: GridSelector): Promise<Resolved | null> {
  const rows = (sel.versionId !== undefined
    ? await sql`
        SELECT id, fiscal_year FROM budget_versions
         WHERE id = ${sel.versionId}::UUID AND company_id = ${companyId}::UUID`
    : sel.fiscalYear !== undefined
      ? await sql`
        SELECT id, fiscal_year FROM budget_versions
         WHERE company_id = ${companyId}::UUID AND fiscal_year = ${sel.fiscalYear}
         ORDER BY is_primary DESC, created_at DESC, id DESC
         LIMIT 1`
      : null) as DbRow[] | null;
  if (rows === null) throw inputError('Name a version or a financial year');
  if (!rows[0]) {
    if (sel.versionId !== undefined) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
    return null;
  }
  return { id: String(rows[0].id), fiscalYear: Number(rows[0].fiscal_year) };
}

async function yearOf(companyId: string, label: number): Promise<BudgetYearInfo> {
  const year = toBudgetYearInfo(await requireFiscalYear(companyId, label));
  if (year.monthKeys.length === 0) throw new BudgetVersionError('BUDGET_VERSION_STATE', `Financial year ${label} has no months`);
  return year;
}

/**
 * The version's token and its cells inside the year's months, on revenue/expense accounts, in a
 * stable order, from one statement. A version gone since it was resolved is BUDGET_VERSION_NOT_FOUND.
 */
async function readCells(companyId: string, versionId: string, year: BudgetYearInfo): Promise<{ token: string; status: string; cells: GridCell[] }> {
  const first = monthKeyToDate(year.monthKeys[0]!);
  const last = monthKeyToDate(year.monthKeys[year.monthKeys.length - 1]!);
  const rows = (await sql`
    WITH v AS (SELECT ${tokenSql()} AS token, status FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID)
    SELECT v.token, v.status, c.gl_account_id, c.cc1_id, c.cc2_id, c.bu_id, c.month, c.amount
      FROM v
      LEFT JOIN LATERAL (
        SELECT bm.gl_account_id, bm.cc1_id, bm.cc2_id, bm.bu_id, to_char(bm.month, 'YYYY-MM') AS month, bm.amount::text AS amount,
               ga.account_code, bm.month AS month_date
          FROM budget_month_amounts bm
          JOIN gl_accounts ga ON ga.id = bm.gl_account_id AND ga.company_id = ${companyId}::UUID
         WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
           AND bm.month BETWEEN ${first}::DATE AND ${last}::DATE
           AND ga.account_type IN ('revenue', 'expense')
      ) c ON true
     ORDER BY c.account_code, c.gl_account_id, c.month_date, c.cc1_id NULLS FIRST, c.cc2_id NULLS FIRST, c.bu_id NULLS FIRST
  `) as DbRow[];
  if (!rows[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  const id = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
  const cells = rows.filter((r) => r.gl_account_id !== null && r.gl_account_id !== undefined).map((r) => ({
    glAccountId: String(r.gl_account_id), cc1Id: id(r.cc1_id), cc2Id: id(r.cc2_id), buId: id(r.bu_id),
    month: String(r.month), amount: Number(r.amount),
  }));
  return { token: String(rows[0].token), status: String(rows[0].status), cells };
}

/** The compare-version fetch (`cells_only=1`): the cells and the token, nothing else. */
export async function loadGridCells(companyId: string, sel: GridSelector): Promise<GridCellsOnly> {
  const found = await resolveVersion(companyId, sel);
  if (!found) return { versionId: null, updatedAt: null, cells: [] };
  const year = await yearOf(companyId, found.fiscalYear);
  const { token, cells } = await readCells(companyId, found.id, year);
  return { versionId: found.id, updatedAt: token, cells };
}

export async function loadGridReadModel(companyId: string, sel: GridSelector): Promise<GridReadModel> {
  const found = await resolveVersion(companyId, sel);
  const label = found?.fiscalYear ?? sel.fiscalYear;
  if (label === undefined) throw inputError('Name a version or a financial year');
  const year = await yearOf(companyId, label);
  const monthCount = year.monthKeys.length;
  const emptyDims = { cc1: [], cc2: [], bu: [] };
  if (!found) {
    return {
      version: null, updatedAt: null, year, accounts: [], dimensions: await loadGridDimensions(companyId, emptyDims), cells: [], grains: {},
      totals: bandTotals([], new Map(), monthCount),
    };
  }

  const version = await getVersion(companyId, found.id);
  const { token, status, cells } = await readCells(companyId, found.id, year);

  const cents = new Map<CellKey, number | null>();
  const used = { cc1: new Set<string>(), cc2: new Set<string>(), bu: new Set<string>() };
  for (const c of cells) {
    cents.set(cellKey({ glAccountId: c.glAccountId, cc1Id: c.cc1Id, cc2Id: c.cc2Id, buId: c.buId, month: c.month }), toCents(c.amount));
    if (c.cc1Id) used.cc1.add(c.cc1Id);
    if (c.cc2Id) used.cc2.add(c.cc2Id);
    if (c.buId) used.bu.add(c.buId);
  }
  const own = ownMonths(cents, year.monthKeys);
  const grains: Map<string, AccountGrain> = accountGrains(cents);
  const accounts = await loadGridAccounts(companyId, own, grains, monthCount);
  const dimensions = await loadGridDimensions(companyId, { cc1: [...used.cc1], cc2: [...used.cc2], bu: [...used.bu] });

  return {
    version: { ...version, updatedAt: token, status: status as BudgetVersion['status'] }, updatedAt: token, year, accounts, dimensions, cells, grains: Object.fromEntries(grains),
    totals: bandTotals(accounts, own, monthCount),
  };
}
