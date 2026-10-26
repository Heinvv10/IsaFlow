/**
 * The Excel import preview (P2 spec 9.2): a parsed template checked against the version's read
 * model and diffed 3-way against the amounts it was downloaded with (`budgetImportBase`, ruling
 * R1): only cells the user changed are changes, and a cell also changed in the version since is a
 * conflict (listed, applied as the user's value). WRITES NOTHING: the commit sends `cells` (the
 * save route's shape) and `updatedAt` (the token at preview) to POST budget-grid/save, so an edit
 * made between preview and commit is a 409 there and the user re-runs the preview.
 *
 * The upload is read (bounded) before the read model loads. Refused whole (400): another version's
 * or year's file, an altered `_meta`, a missing or altered `_base`, month headers that are not the
 * year's months. Per row: an unknown account or member code, an account budgeted at
 * another grain in this version (decision 4), a row key twice (both copies), a cell that is not an
 * amount, and new amounts on a header or inactive account that holds none (save refuses those,
 * decision 18) are ERRORS and the row is left out; a header or inactive account that already holds
 * amounts is a WARNING, as is a version saved since the download. Rows absent from the file are
 * untouched; a blank cell clears; 0 is a budgeted zero. Codes compare trimmed. At most MAX_ISSUES
 * errors and warnings are listed (`errorCount` / `warningCount` count them all), and upload text
 * echoed in a message is clipped. Amounts on the wire are rand, as the read model's.
 */
import { fromCents } from './grid/cents';
import { parseKey, type CellKey } from './grid/cellKey';
import type { DiffCounts } from './grid/diff';
import type { BandTotals } from './grid/subtotals';
import { inputError } from './gridErrors';
import { loadGridReadModel } from './gridReadModel';
import { bandTotals, ownMonths } from './gridTotals';
import { cellsInCents, COLUMN, GRAIN_LABEL, templateRowKey, type TemplateGrain } from './budgetTemplateXlsx';
import { clip, parseLayout, parseLines, parseMeta, readBudgetWorkbook, type BudgetWorkbook, type ImportLine } from './budgetImportParse';
import { lineKey, parseBase, tampered, threeWay } from './budgetImportBase';
import type { GridAccount, GridMember, GridReadModel } from './gridReadTypes';
import type { SaveCell } from './gridSaveValidate';

/** Errors and warnings listed in one preview; the counts say how many there were. */
export const MAX_ISSUES = 200;

export interface ImportIssue {
  /** The sheet row (1-based); 0 for the file as a whole. */
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
  /** Cells changed in the file AND in the version since the download (rand): applied as the file's `after`. */
  conflicts: Array<{ key: CellKey; downloaded: number | null; current: number | null; after: number | null }>;
  /** The first MAX_ISSUES, by row. */
  errors: ImportIssue[];
  warnings: ImportIssue[];
  errorCount: number;
  warningCount: number;
  /** More errors or warnings than are listed. */
  truncated: boolean;
  /** Band totals and GP / OP / NP per month and FY, rand: the version now, and with the valid rows applied. */
  totals: { before: BandTotals; after: BandTotals };
}

const refuse = (message: string): never => { throw inputError(message); };
const rand = (cents: number | null): number | null => (cents === null ? null : fromCents(cents));

interface Resolved { line: ImportLine; account: GridAccount; rowKey: string }

/** Each line's account and member, or the issues that leave it out. */
function resolveLines(model: GridReadModel, grain: TemplateGrain, lines: readonly ImportLine[], cents: ReadonlyMap<CellKey, number>) {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const byCode = new Map<string, GridAccount | null>();
  for (const a of model.accounts) byCode.set(a.code.trim(), byCode.has(a.code.trim()) ? null : a);
  const members = new Map<string, GridMember>((grain === 'company' ? [] : model.dimensions[grain]).map((m) => [m.code.trim(), m]));
  const holds = new Set([...cents.keys()].map((k) => k.slice(0, k.indexOf('|'))));
  const resolved: Resolved[] = [];

  for (const line of lines) {
    const error = (column: string, message: string) => errors.push({ row: line.row, column, message });
    const account = byCode.get(line.accountCode);
    if (line.accountCode === '') { error(COLUMN.accountCode, 'This row has amounts but no account code.'); continue; }
    if (account === null) { error(COLUMN.accountCode, `Account code ${clip(line.accountCode)} is used by more than one account; fix the chart of accounts first.`); continue; }
    if (account === undefined) {
      error(COLUMN.accountCode, `Account code ${clip(line.accountCode)} is not a revenue or expense account you can budget (unknown, or inactive without a budget).`);
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
      if (!member) { error(COLUMN.dimensionCode, `${GRAIN_LABEL[grain]} code ${clip(line.dimensionCode || '(blank)')} is not one of this company's ${GRAIN_LABEL[grain]} members.`); continue; }
      memberId = member.id;
    }
    const bad = line.amounts.filter((a) => a.cell.kind === 'error');
    for (const a of bad) if (a.cell.kind === 'error') error(a.month, a.cell.raw === '' ? a.cell.reason : `"${clip(a.cell.raw)}": ${a.cell.reason}`);
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
    errors.push({ row: r.line.row, column: COLUMN.accountCode, message: `${r.account.code}${r.line.dimensionCode ? ` / ${clip(r.line.dimensionCode)}` : ''} appears more than once (also on row ${clip(others)}).` });
    return false;
  });
  errors.sort((a, b) => a.row - b.row);
  return { rows: unique, errors, warnings };
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
  const base = parseBase(wb.base, months, meta.grain);
  const current = cellsInCents(model);
  const { rows, errors, warnings } = resolveLines(model, meta.grain, parseLines(data, layout), current);
  const diff = threeWay(rows.map((r) => ({
    rowKey: r.rowKey,
    base: base.get(lineKey(r.line.accountCode, r.line.dimensionCode)) ?? null,
    file: r.line.amounts.map((a) => (a.cell.kind === 'value' ? a.cell.cents : null)),
  })), months, current);
  if (meta.updatedAt === model.updatedAt) {
    if (diff.moved > 0) return tampered(); // nothing was saved since the download, so _base must be the version
  } else {
    const n = diff.moved, k = diff.conflicts.length;
    warnings.unshift({
      row: 0, column: '', message: `This budget was saved after you downloaded this file: ${n} ${n === 1 ? 'cell' : 'cells'} in it changed since you downloaded it. `
        + `Cells you left as downloaded keep the newer amounts; ${k} ${k === 1 ? 'cell' : 'cells'} you changed that also changed in IsaFlow ${k === 1 ? 'is' : 'are'} listed as conflicts and take your amount.`,
    });
  }

  const after = new Map<CellKey, number | null>(current);
  for (const c of diff.changes) after.set(c.key, c.after);
  return {
    updatedAt: model.updatedAt,
    changes: diff.changes.map((c) => ({ key: c.key, before: rand(c.before), after: rand(c.after) })),
    cells: diff.changes.map((c) => ({ ...parseKey(c.key), amount: rand(c.after) })),
    counts: diff.counts,
    conflicts: diff.conflicts.map((c) => ({ key: c.key, downloaded: rand(c.downloaded), current: rand(c.current), after: rand(c.after) })),
    errors: errors.slice(0, MAX_ISSUES), warnings: warnings.slice(0, MAX_ISSUES),
    errorCount: errors.length, warningCount: warnings.length, truncated: errors.length > MAX_ISSUES || warnings.length > MAX_ISSUES,
    totals: { before: model.totals, after: bandTotals(model.accounts, ownMonths(after, months), months.length) },
  };
}

/** Read the upload (bounded, before any database read), then preview it against the company's version (another tenant's: BUDGET_VERSION_NOT_FOUND). */
export async function buildImportPreview(companyId: string, versionId: string, file: Buffer): Promise<ImportPreview> {
  const wb = await readBudgetWorkbook(file);
  return previewImport(await loadGridReadModel(companyId, { versionId }), versionId, wb);
}
