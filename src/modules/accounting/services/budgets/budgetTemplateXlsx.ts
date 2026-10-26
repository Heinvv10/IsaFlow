/**
 * The budget grid's Excel template (P2 spec 9.1): one version at one grain, built with exceljs.
 *
 * Sheet `Budget`: Section | Account code | Account name | [Dimension code | Dimension name] | one
 * column per year month, headed by the TEXT 'YYYY-MM' (never a date, so no locale reformats it) |
 * FY total (a formula, ignored on import) | PY actual (information, ignored). A blank cell is "not
 * budgeted", 0 a budgeted zero. At a dimension grain there is one row per account x member, and
 * only accounts budgeted at that grain or not yet budgeted are offered (decision 4). Hidden,
 * protected `_meta` names the version, year, grain and token the file was cut from; `Instructions`
 * states the blank-vs-0 and absent-row rules. The import (budgetImportParse / budgetImportDiff)
 * reads exactly this layout back, so template -> import is no change (invariant 3).
 */
import ExcelJS from 'exceljs';
import { cellKey, rowKeyOf, type CellKey } from './grid/cellKey';
import { gridOf } from './grid/diff';
import { fromCents, toCents } from './grid/cents';
import { BAND_LABEL, BAND_ORDER } from './grid/subtotals';
import { loadGridReadModel } from './gridReadModel';
import { loadPriorActuals, PRIOR_GRAINS, type PriorActuals, type PriorGrain } from './priorActuals';
import type { GridAccount, GridMember, GridReadModel } from './gridReadTypes';

export type TemplateGrain = PriorGrain;
export const TEMPLATE_GRAINS: readonly TemplateGrain[] = PRIOR_GRAINS;
export const TEMPLATE_VERSION = 1;
export const BUDGET_SHEET = 'Budget';
export const META_SHEET = '_meta';
export const INSTRUCTIONS_SHEET = 'Instructions';
export const MONEY_FORMAT = '#,##0.00';

export const COLUMN = {
  section: 'Section', accountCode: 'Account code', accountName: 'Account name',
  dimensionCode: 'Dimension code', dimensionName: 'Dimension name', fyTotal: 'FY total', pyActual: 'PY actual',
} as const;

export interface TemplateMeta {
  versionId: string;
  fiscalYear: number;
  grain: TemplateGrain;
  /** The version's token when the file was cut (information: the import diffs against the version as it is now). */
  updatedAt: string;
  templateVersion: number;
}

export interface TemplateRow {
  account: GridAccount;
  member: GridMember | null;
  /** `cellKey.rowKeyOf` of the row's cells. */
  rowKey: string;
}

export const GRAIN_LABEL: Readonly<Record<TemplateGrain, string>> = { company: 'company', cc1: 'CC1', cc2: 'CC2', bu: 'BU' };

/** The version's cells in integer cents, by cell key. */
export function cellsInCents(model: GridReadModel): Map<CellKey, number> {
  return new Map(model.cells.map((c) => [cellKey(c), toCents(c.amount)]));
}

/** A row's key at `grain`: the account and, at a dimension grain, the member in its slot. */
export function templateRowKey(accountId: string, grain: TemplateGrain, memberId: string | null): string {
  return rowKeyOf(cellKey({
    glAccountId: accountId, cc1Id: grain === 'cc1' ? memberId : null, cc2Id: grain === 'cc2' ? memberId : null,
    buId: grain === 'bu' ? memberId : null, month: '2000-01',
  }));
}

/** An account the grid edits as a line: a leaf, or a legacy header holding its own amounts (decision 18). */
export const isBudgetLine = (a: GridAccount): boolean => !a.isHeader || a.ownAmounts;

/**
 * The template's rows: by band, then in the read model's order. An account is offered at `grain`
 * when it is a budget line already at that grain or holding nothing. At a dimension grain each
 * active member is a row, and an inactive member only where the account already budgets it.
 */
export function templateRows(model: GridReadModel, grain: TemplateGrain, cents: ReadonlyMap<CellKey, number>): TemplateRow[] {
  const heldRows = new Set([...cents.keys()].map(rowKeyOf));
  const offered = model.accounts.filter((a) => isBudgetLine(a) && (a.grain === null || a.grain === grain));
  const ordered = BAND_ORDER.flatMap((band) => offered.filter((a) => a.band === band));
  if (grain === 'company') return ordered.map((account) => ({ account, member: null, rowKey: templateRowKey(account.id, grain, null) }));
  const members = model.dimensions[grain];
  return ordered.flatMap((account) => members
    .map((member) => ({ account, member, rowKey: templateRowKey(account.id, grain, member.id) }))
    .filter((r) => r.member.isActive || heldRows.has(r.rowKey)));
}

/** PY actual (FY, cents) per template row key. */
function priorByRow(prior: PriorActuals, grain: TemplateGrain): Map<string, number> {
  const out = new Map<string, number>();
  for (const c of prior.cells) {
    if (grain !== 'company' && c.dimensionId === null) continue;
    const key = templateRowKey(c.glAccountId, grain, grain === 'company' ? null : c.dimensionId);
    out.set(key, (out.get(key) ?? 0) + toCents(c.amount));
  }
  return out;
}

const INSTRUCTIONS = [
  'How to fill in this budget template',
  '',
  'Enter amounts in the month columns of the Budget sheet, in rand. Do not rename, move or retype the month headers (YYYY-MM).',
  'A BLANK cell means "not budgeted". A 0 means "budgeted at zero". Clearing a cell that held an amount removes that budget on import.',
  'Rows you delete from the sheet are left as they are in IsaFlow: only the rows in the file are compared.',
  'Do not change the Account code or Dimension code of a row; add a row by copying one and changing its amounts only.',
  'The FY total and PY actual columns are for reference and are ignored on import.',
  'Upload the file back to the same budget version. IsaFlow shows every change before anything is saved.',
  'Do not edit the hidden _meta sheet: it ties this file to its budget version and financial year.',
];

/** The workbook for `model` at `grain`, with `prior` the year's prior actuals at that grain. */
export async function buildBudgetTemplate(model: GridReadModel, grain: TemplateGrain, prior: PriorActuals): Promise<Buffer> {
  if (!model.version || model.updatedAt === null) throw new RangeError('A template needs a version');
  const months = model.year.monthKeys;
  const cents = cellsInCents(model);
  const rows = templateRows(model, grain, cents);
  const values = gridOf(rows.map((r) => r.rowKey), months, cents);
  const py = priorByRow(prior, grain);
  const dims = grain !== 'company';

  const wb = new ExcelJS.Workbook();
  wb.creator = 'IsaFlow';
  const ws = wb.addWorksheet(BUDGET_SHEET);
  const labels: string[] = [COLUMN.section, COLUMN.accountCode, COLUMN.accountName, ...(dims ? [COLUMN.dimensionCode, COLUMN.dimensionName] : [])];
  ws.addRow([...labels, ...months, COLUMN.fyTotal, COLUMN.pyActual]).font = { bold: true };
  const firstMonth = labels.length + 1;
  const lastMonth = labels.length + months.length;
  const firstLetter = ws.getColumn(firstMonth).letter;
  const lastLetter = ws.getColumn(lastMonth).letter;

  for (const r of rows) {
    const monthValues = months.map((m) => values.get(`${r.rowKey}|${m}`) ?? null);
    const fy = monthValues.reduce<number>((s, v) => s + (v ?? 0), 0);
    const label = [BAND_LABEL[r.account.band], r.account.code, r.account.name, ...(r.member ? [r.member.code, r.member.name] : [])];
    const row = ws.addRow([...label, ...monthValues.map((v) => (v === null ? null : fromCents(v)))]);
    row.getCell(lastMonth + 1).value = { formula: `SUM(${firstLetter}${row.number}:${lastLetter}${row.number})`, result: fromCents(fy) };
    const pyCents = py.get(r.rowKey);
    row.getCell(lastMonth + 2).value = pyCents === undefined ? null : fromCents(pyCents);
  }
  for (let c = firstMonth; c <= lastMonth + 2; c++) {
    ws.getColumn(c).numFmt = MONEY_FORMAT;
    ws.getColumn(c).width = 14;
  }
  ws.getColumn(1).width = 20;
  ws.getColumn(2).width = 14;
  ws.getColumn(3).width = 36;
  if (dims) { ws.getColumn(4).width = 16; ws.getColumn(5).width = 28; }
  ws.views = [{ state: 'frozen', xSplit: labels.length, ySplit: 1 }];

  const help = wb.addWorksheet(INSTRUCTIONS_SHEET);
  help.getColumn(1).width = 120;
  for (const line of INSTRUCTIONS) help.addRow([line]);
  help.getRow(1).font = { bold: true };
  help.addRow([]);
  help.addRow([`Budget version: ${model.version.name}, financial year ${model.year.fiscalYear}, ${GRAIN_LABEL[grain]} level.`]);

  const meta = wb.addWorksheet(META_SHEET, { state: 'hidden' });
  const m: TemplateMeta = { versionId: model.version.id, fiscalYear: model.year.fiscalYear, grain, updatedAt: model.updatedAt, templateVersion: TEMPLATE_VERSION };
  for (const [k, v] of Object.entries(m)) meta.addRow([k, String(v)]);
  await meta.protect('', { selectLockedCells: true, selectUnlockedCells: true });

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** The template for one of the company's versions; another tenant's id is BUDGET_VERSION_NOT_FOUND. */
export async function loadBudgetTemplate(companyId: string, versionId: string, grain: TemplateGrain): Promise<{ file: Buffer; fileName: string }> {
  const model = await loadGridReadModel(companyId, { versionId });
  const prior = await loadPriorActuals(companyId, model.year.fiscalYear, grain);
  const name = (model.version?.name ?? 'budget').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'budget';
  return { file: await buildBudgetTemplate(model, grain, prior), fileName: `budget-FY${model.year.fiscalYear}-${name}-${grain}.xlsx` };
}
