/**
 * The Excel import preview (P2 spec 9.2): a parsed template checked against the version's read
 * model and diffed with `grid/diff.diffCells`. WRITES NOTHING: the commit sends `cells` (the save
 * route's shape) and `updatedAt` (the token at preview) to POST budget-grid/save, so an edit made
 * between preview and commit is a 409 there and the user re-runs the preview.
 *
 * Refused whole (400): another version's or year's file, an altered `_meta`, month headers that
 * are not the year's months. Per row: an unknown account or member code, an account budgeted at
 * another grain in this version (decision 4), a row key twice (both copies), a cell that is not an
 * amount, and new amounts on a header or inactive account that holds none (save refuses those,
 * decision 18) are ERRORS and the row is left out; a header or inactive account that already holds
 * amounts is a WARNING. Rows absent from the file are untouched; a blank cell clears; 0 is a
 * budgeted zero. Amounts on the wire are rand, as the read model's.
 */
import { fromCents } from './grid/cents';
import { parseKey, type CellKey } from './grid/cellKey';
import { diffCells, type DiffCounts } from './grid/diff';
import { foldBands, type BandTotals, type Metric } from './grid/subtotals';
import { loadGridReadModel } from './gridReadModel';
import { BudgetVersionError } from './budgetVersionTypes';
import { cellsInCents, COLUMN, GRAIN_LABEL, isBudgetLine, templateRowKey, type TemplateGrain } from './budgetTemplateXlsx';
import { parseLayout, parseLines, parseMeta, readBudgetWorkbook, type BudgetWorkbook, type ImportLine } from './budgetImportParse';
import type { GridAccount, GridMember, GridReadModel } from './gridReadTypes';
import type { SaveCell } from './gridSaveValidate';

export interface ImportIssue {
  /** The sheet row (1-based). */
  row: number;
  /** The column's header text ('Account code', 'Dimension code', '2026-03', ...). */
  column: string;
  message: string;
}

export interface ImportPreview {
  /** The version's token at preview: commit sends it as `expectedUpdatedAt`. */
  updatedAt: string;
  changes: Array<{ key: CellKey; before: number | null; after: number | null }>;
  /** The changed cells in the save route's shape (`amount: null` clears). */
  cells: SaveCell[];
  counts: DiffCounts;
  errors: ImportIssue[];
  warnings: ImportIssue[];
  /** Band totals and GP / OP / NP per month and FY, rand: the version now, and with the valid rows applied. */
  totals: { before: BandTotals; after: BandTotals };
}

const refuse = (message: string): never => { throw new BudgetVersionError('BUDGET_VERSION_INPUT', message); };

interface Resolved { line: ImportLine; account: GridAccount; rowKey: string }

/** Each line's account and member, or the issues that leave it out. */
function resolveLines(model: GridReadModel, grain: TemplateGrain, lines: readonly ImportLine[], cents: ReadonlyMap<CellKey, number>) {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const byCode = new Map<string, GridAccount | null>();
  for (const a of model.accounts) byCode.set(a.code, byCode.has(a.code) ? null : a);
  const members = new Map<string, GridMember>((grain === 'company' ? [] : model.dimensions[grain]).map((m) => [m.code, m]));
  const holds = new Set([...cents.keys()].map((k) => k.slice(0, k.indexOf('|'))));
  const resolved: Resolved[] = [];

  for (const line of lines) {
    const error = (column: string, message: string) => errors.push({ row: line.row, column, message });
    const account = byCode.get(line.accountCode);
    if (line.accountCode === '') { error(COLUMN.accountCode, 'This row has amounts but no account code.'); continue; }
    if (account === null) { error(COLUMN.accountCode, `Account code ${line.accountCode} is used by more than one account; fix the chart of accounts first.`); continue; }
    if (account === undefined) {
      error(COLUMN.accountCode, `Account code ${line.accountCode} is not a revenue or expense account you can budget (unknown, or inactive without a budget).`);
      continue;
    }
    if (account.grain !== null && account.grain !== grain) {
      const held = account.grain;
      error(COLUMN.accountCode, held === 'mixed'
        ? `${account.code} ${account.name} is budgeted at more than one level in this version; change it in the budget grid.`
        : `${account.code} ${account.name} is budgeted by ${GRAIN_LABEL[held]} in this version, not by ${GRAIN_LABEL[grain]}: download the ${GRAIN_LABEL[held]} template to change it.`);
      continue;
    }
    let memberId: string | null = null;
    if (grain !== 'company') {
      const member = members.get(line.dimensionCode ?? '');
      if (!member) { error(COLUMN.dimensionCode, `${GRAIN_LABEL[grain]} code ${line.dimensionCode || '(blank)'} is not one of this company's ${GRAIN_LABEL[grain]} members.`); continue; }
      memberId = member.id;
    }
    const bad = line.amounts.filter((a) => a.cell.kind === 'error');
    for (const a of bad) if (a.cell.kind === 'error') error(a.month, a.cell.raw === '' ? a.cell.reason : `"${a.cell.raw}": ${a.cell.reason}`);
    if (bad.length > 0) continue;
    const kind = account.isHeader ? 'a header account' : !account.isActive ? 'inactive' : null;
    if (kind && !holds.has(account.id)) {
      if (line.amounts.some((a) => a.cell.kind === 'value')) {
        error(COLUMN.accountCode, `${account.code} ${account.name} is ${kind} with no budget in this version; a new budget there is refused. Budget a sub-account or an active account instead.`);
        continue;
      }
    } else if (kind) {
      warnings.push({ row: line.row, column: COLUMN.accountCode, message: `${account.code} ${account.name} is ${kind}; it keeps the budget it already holds.` });
    }
    resolved.push({ line, account, rowKey: templateRowKey(account.id, grain, memberId) });
  }

  // A row key twice: neither copy is known to be the one meant, so both are left out.
  const rowsOf = new Map<string, number[]>();
  for (const r of resolved) rowsOf.set(r.rowKey, [...(rowsOf.get(r.rowKey) ?? []), r.line.row]);
  const unique = resolved.filter((r) => {
    const at = rowsOf.get(r.rowKey)!;
    if (at.length === 1) return true;
    const others = at.filter((n) => n !== r.line.row).join(', ');
    errors.push({ row: r.line.row, column: COLUMN.accountCode, message: `${r.account.code}${r.line.dimensionCode ? ` / ${r.line.dimensionCode}` : ''} appears more than once (also on row ${others}).` });
    return false;
  });
  errors.sort((a, b) => a.row - b.row);
  return { rows: unique, errors, warnings };
}

/** Band totals in rand: lines and a legacy header's own amounts, once each (the read model's rule). */
function totalsOf(model: GridReadModel, values: ReadonlyMap<CellKey, number | null>): BandTotals {
  const monthIndex = new Map(model.year.monthKeys.map((m, i) => [m, i]));
  const own = new Map<string, number[]>();
  for (const [key, v] of values) {
    if (v === null) continue;
    const parts = key.split('|');
    const i = monthIndex.get(parts[4]!);
    if (i === undefined) continue;
    const months = own.get(parts[0]!) ?? Array<number>(model.year.monthKeys.length).fill(0);
    months[i] = (months[i] ?? 0) + v;
    own.set(parts[0]!, months);
  }
  const t = foldBands(model.accounts.filter(isBudgetLine), (a) => own.get(a.id) ?? [], model.year.monthKeys.length);
  const months = Object.fromEntries(Object.entries(t.months).map(([k, v]) => [k, v.map(fromCents)])) as Record<Metric, number[]>;
  const fy = Object.fromEntries(Object.entries(t.fy).map(([k, v]) => [k, fromCents(v)])) as Record<Metric, number>;
  return { months, fy };
}

/** The preview of `wb` against the version `versionId` as `model` holds it now. Pure. */
export function previewImport(model: GridReadModel, versionId: string, wb: BudgetWorkbook): ImportPreview {
  if (!model.version || model.updatedAt === null) return refuse('Budget version not found');
  const meta = parseMeta(wb.meta);
  if (meta.versionId !== versionId.toLowerCase()) {
    return refuse('This file was downloaded for another budget version. Pick that version or re-download the template for this one.');
  }
  if (meta.fiscalYear !== model.year.fiscalYear) {
    return refuse(`This file is for financial year ${meta.fiscalYear}, but this version is for ${model.year.fiscalYear}. Re-download the template.`);
  }
  const months = model.year.monthKeys;
  const [header, ...data] = wb.budget;
  const layout = parseLayout(header, months, meta.grain);
  const base = cellsInCents(model);
  const { rows, errors, warnings } = resolveLines(model, meta.grain, parseLines(data, layout), base);

  const incoming = new Map<CellKey, number | null>();
  for (const r of rows) {
    for (const a of r.line.amounts) incoming.set(`${r.rowKey}|${a.month}`, a.cell.kind === 'value' ? a.cell.cents : null);
  }
  const { changes, counts } = diffCells(base, incoming);
  const after = new Map<CellKey, number | null>(base);
  for (const c of changes) after.set(c.key, c.after);

  const cells: SaveCell[] = changes.map((c) => ({ ...parseKey(c.key), amount: c.after === null ? null : fromCents(c.after) }));
  return {
    updatedAt: model.updatedAt,
    changes: changes.map((c) => ({ key: c.key, before: c.before === null ? null : fromCents(c.before), after: c.after === null ? null : fromCents(c.after) })),
    cells, counts, errors, warnings,
    totals: { before: totalsOf(model, base), after: totalsOf(model, after) },
  };
}

/** Read the upload and preview it against the company's version (another tenant's: BUDGET_VERSION_NOT_FOUND). */
export async function buildImportPreview(companyId: string, versionId: string, file: Buffer): Promise<ImportPreview> {
  const model = await loadGridReadModel(companyId, { versionId });
  return previewImport(model, versionId, await readBudgetWorkbook(file));
}
