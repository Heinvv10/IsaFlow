/**
 * The Excel import preview (P2 spec 9.2): a parsed template checked against the version's read
 * model and diffed 3-way against the amounts it was downloaded with (`budgetImportBase`, ruling
 * R1): only cells the user changed are changes, and a cell also changed in the version since is a
 * conflict (listed, applied as the user's value). WRITES NOTHING: the commit sends `cells` (the
 * save route's shape) and `updatedAt` (the token at preview) to POST budget-grid/save, so an edit
 * made between preview and commit is a 409 there and the user re-runs the preview.
 *
 * The upload is read (bounded) before the read model loads. Refused whole (400): another version's
 * or year's file, an altered `_meta`, an altered or forged `_base` (its signature, Q4), month
 * headers that are not the year's months. A file with NO `_base` (Q3b) is diffed against the
 * version as it is now, every change flagged `possibleRevert`, with a warning. Every change
 * carries `currentChangedAt`, when the cell it replaces was last written (Q3c). Per row: an unknown account or member code, an account budgeted at
 * another grain in this version (decision 4), a row key twice (both copies), a cell that is not an
 * amount, and new amounts on a header or inactive account that holds none (save refuses those,
 * decision 18) are ERRORS and the row is left out; a header or inactive account that already holds
 * amounts is a WARNING, as is a version saved since the download. Rows absent from the file are
 * untouched; a blank cell clears; 0 is a budgeted zero. Codes match as budgetImportResolve says. At most MAX_ISSUES
 * errors and warnings are listed (`errorCount` / `warningCount` count them all), and upload text
 * echoed in a message is clipped. Amounts on the wire are rand, as the read model's.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fromCents } from './grid/cents';
import { parseKey, type CellKey } from './grid/cellKey';
import type { DiffCounts } from './grid/diff';
import type { BandTotals } from './grid/subtotals';
import { inputError } from './gridErrors';
import { BudgetVersionError } from './budgetVersionTypes';
import { loadGridReadModel } from './gridReadModel';
import { bandTotals, ownMonths } from './gridTotals';
import { cellsInCents } from './budgetTemplateXlsx';
import { baseDigest, signatureMatches } from './budgetTemplateSignature';
import { parseLayout, parseLines, parseMeta, readBudgetWorkbook, type BudgetWorkbook } from './budgetImportParse';
import { parseBase, tampered, threeWay } from './budgetImportBase';
import { baseByRowKey, resolveLines, type ImportIssue } from './budgetImportResolve';
import type { GridReadModel } from './gridReadTypes';
import { MAX_IMPORT_CELLS, type SaveCell } from './gridSaveValidate';

export type { ImportIssue } from './budgetImportResolve';

/** Errors and warnings listed in one preview; the counts say how many there were. */
export const MAX_ISSUES = 200;

export interface ImportChange {
  key: CellKey;
  before: number | null;
  after: number | null;
  /** The file has no `_base`, so this change may undo someone else's later save (Q3b). */
  possibleRevert: boolean;
  /** When the cell this replaces was last written (UTC ISO, microseconds); null for a new cell. */
  currentChangedAt: string | null;
}

export interface ImportPreview {
  /** The version's token at preview: commit sends it as `expectedUpdatedAt`. */
  updatedAt: string;
  changes: ImportChange[];
  /** The changed cells in the save route's shape (`amount: null, clear: true` clears). */
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

const NO_BASE = 'This file has no record of what you downloaded; every difference is shown as a change, including values others saved since — check each one before you commit.';

/** The preview of `wb` against the version `versionId` as `model` holds it now. Pure (`currentChangedAt` is null here). */
export function previewImport(model: GridReadModel, versionId: string, wb: BudgetWorkbook): ImportPreview {
  if (!model.version || model.updatedAt === null) return refuse('Budget version not found');
  const meta = parseMeta(wb.meta);
  if (meta.versionId !== versionId.toLowerCase()) {
    return refuse('This file was downloaded for another budget version. Pick that version, or download a fresh template for this one and make your changes in it.');
  }
  if (meta.fiscalYear !== model.year.fiscalYear) {
    return refuse(`This file is for financial year ${meta.fiscalYear}, but this version is for ${model.year.fiscalYear}. Download a fresh template and make your changes in it.`);
  }
  const months = model.year.monthKeys;
  const [header, ...data] = wb.budget;
  const layout = parseLayout(header, months, meta.grain);
  const current = cellsInCents(model);
  let base: Map<string, ReadonlyArray<number | null>> | null = null;
  if (wb.base) {
    const lines = parseBase(wb.base, months, meta.grain);
    if (!signatureMatches(meta, baseDigest(wb.base.map((r) => r.cells)), meta.signature)) return tampered();
    base = baseByRowKey(model, meta.grain, lines);
  }
  const lines = parseLines(data, layout);
  if (lines.length * months.length > MAX_IMPORT_CELLS) {
    // The reader's row limit is a 12-month year's; a longer year's file must still fit one save (L2).
    return refuse(`This file has ${lines.length} rows of ${months.length} months, more than the ${MAX_IMPORT_CELLS} cells one import can hold. `
      + `Split it: download templates for fewer members, or remove rows you are not changing, and import each part.`);
  }
  const { rows, errors, warnings } = resolveLines(model, meta.grain, lines, current);
  const diff = threeWay(rows.map((r) => ({
    rowKey: r.rowKey,
    // No _base: the version now stands in for what was downloaded, so every difference is a change.
    base: base ? base.get(r.rowKey) ?? null : months.map((m) => current.get(`${r.rowKey}|${m}`) ?? null),
    file: r.line.amounts.map((a) => (a.cell.kind === 'value' ? a.cell.cents : null)),
  })), months, current);
  if (!base) {
    warnings.unshift({ row: 0, column: '', message: NO_BASE });
  } else if (meta.updatedAt === model.updatedAt) {
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
    changes: diff.changes.map((c) => ({ key: c.key, before: rand(c.before), after: rand(c.after), possibleRevert: !base, currentChangedAt: null })),
    cells: diff.changes.map((c) => (c.after === null ? { ...parseKey(c.key), amount: null, clear: true } : { ...parseKey(c.key), amount: rand(c.after) })),
    counts: diff.counts,
    conflicts: diff.conflicts.map((c) => ({ key: c.key, downloaded: rand(c.downloaded), current: rand(c.current), after: rand(c.after) })),
    errors: errors.slice(0, MAX_ISSUES), warnings: warnings.slice(0, MAX_ISSUES),
    errorCount: errors.length, warningCount: warnings.length, truncated: errors.length > MAX_ISSUES || warnings.length > MAX_ISSUES,
    totals: { before: model.totals, after: bandTotals(model.accounts, ownMonths(after, months), months.length) },
  };
}

/** When each changed cell that exists now was last written (Q3c), read for the changed accounts only. */
async function changedAt(companyId: string, versionId: string, changes: readonly ImportChange[]): Promise<Map<CellKey, string>> {
  const replaced = changes.filter((c) => c.before !== null);
  if (replaced.length === 0) return new Map();
  const accounts = [...new Set(replaced.map((c) => c.key.slice(0, c.key.indexOf('|'))))];
  const rows = (await sql`
    SELECT bm.gl_account_id, bm.cc1_id, bm.cc2_id, bm.bu_id, to_char(bm.month, 'YYYY-MM') AS month,
           to_char(bm.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS changed_at
      FROM budget_month_amounts bm
     WHERE bm.company_id = ${companyId}::UUID AND bm.version_id = ${versionId}::UUID
       AND bm.gl_account_id IN (SELECT unnest(${accounts}::UUID[]))
  `) as DbRow[];
  const id = (v: unknown) => (v === null || v === undefined ? '' : String(v));
  return new Map(rows.map((r) => [`${id(r.gl_account_id)}|${id(r.cc1_id)}|${id(r.cc2_id)}|${id(r.bu_id)}|${String(r.month)}`, String(r.changed_at)]));
}

/**
 * Preview the upload against the company's version. The version is confirmed first (one indexed
 * row), so another tenant's or a deleted one is BUDGET_VERSION_NOT_FOUND without paying the parse;
 * then the upload is read (bounded), then the read model.
 */
export async function buildImportPreview(companyId: string, versionId: string, file: Buffer): Promise<ImportPreview> {
  const found = (await sql`SELECT 1 FROM budget_versions WHERE id = ${versionId}::UUID AND company_id = ${companyId}::UUID`) as DbRow[];
  if (!found[0]) throw new BudgetVersionError('BUDGET_VERSION_NOT_FOUND', 'Budget version not found');
  const wb = await readBudgetWorkbook(file);
  const preview = previewImport(await loadGridReadModel(companyId, { versionId }), versionId, wb);
  const at = await changedAt(companyId, versionId, preview.changes);
  return { ...preview, changes: preview.changes.map((c) => ({ ...c, currentChangedAt: at.get(c.key) ?? null })) };
}
