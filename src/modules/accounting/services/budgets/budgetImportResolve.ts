/**
 * The import's rows matched to the chart (budgets P2 spec 9.2): each Budget-sheet line to its
 * account and, at a dimension grain, its member, or the row errors that leave it out; and each
 * `_base` row to the same cell-key row, so the 3-way diff compares like with like.
 *
 * Codes match EXACTLY first (as the chart holds them, the template's apostrophe removed), and
 * trimmed only when the trimmed form belongs to one code alone (VER-L6): "4000" and "4000 " are
 * two accounts and each keeps its row; a retyped "4000 " -> "4000" still finds the one it meant.
 * A row key twice is an error on every copy, grouped in one pass (SEC2-M1), naming a few others.
 */
import type { CellKey } from './grid/cellKey';
import { COLUMN, GRAIN_LABEL, templateRowKey, type TemplateGrain } from './budgetTemplateXlsx';
import { clip, type ImportLine } from './budgetImportParse';
import { tampered, type BaseLine } from './budgetImportBase';
import type { GridAccount, GridMember, GridReadModel } from './gridReadTypes';

export interface ImportIssue {
  /** The sheet row (1-based); 0 for the file as a whole. */
  row: number;
  /** The column's header text ('Account code', 'Dimension code', '2026-03', ...). */
  column: string;
  message: string;
}

export interface ResolvedLine { line: ImportLine; account: GridAccount; rowKey: string }

/** A code's owner: the item, null when the code (or its trimmed form) belongs to more than one, undefined when to none. */
type Find<T> = (code: string) => T | null | undefined;

function codeIndex<T extends { code: string }>(items: readonly T[]): Find<T> {
  const exact = new Map<string, T | null>();
  const trimmed = new Map<string, T | null>();
  for (const item of items) {
    exact.set(item.code, exact.has(item.code) ? null : item);
    const t = item.code.trim();
    trimmed.set(t, trimmed.has(t) ? null : item);
  }
  return (code) => (exact.has(code) ? exact.get(code) : trimmed.get(code.trim()));
}

interface Finders { account: Find<GridAccount>; member: Find<GridMember> }

function finders(model: GridReadModel, grain: TemplateGrain): Finders {
  return { account: codeIndex(model.accounts), member: codeIndex(grain === 'company' ? [] : model.dimensions[grain]) };
}

/** How many other rows a duplicate's message names. */
const OTHERS_SHOWN = 3;

/** Each line's account and member, or the issues that leave it out. */
export function resolveLines(model: GridReadModel, grain: TemplateGrain, lines: readonly ImportLine[], cents: ReadonlyMap<CellKey, number>) {
  const errors: ImportIssue[] = [];
  const warnings: ImportIssue[] = [];
  const find = finders(model, grain);
  const holds = new Set([...cents.keys()].map((k) => k.slice(0, k.indexOf('|'))));
  const resolved: ResolvedLine[] = [];

  for (const line of lines) {
    const error = (column: string, message: string) => errors.push({ row: line.row, column, message });
    if (line.accountCode.trim() === '') { error(COLUMN.accountCode, 'This row has amounts but no account code.'); continue; }
    const account = find.account(line.accountCode);
    if (account === null) { error(COLUMN.accountCode, `Account code ${clip(line.accountCode)} matches more than one account; fix the chart of accounts first.`); continue; }
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
      const member = find.member(line.dimensionCode ?? '');
      if (!member) {
        error(COLUMN.dimensionCode, member === null
          ? `${GRAIN_LABEL[grain]} code ${clip(line.dimensionCode ?? '')} matches more than one ${GRAIN_LABEL[grain]} member.`
          : `${GRAIN_LABEL[grain]} code ${clip(line.dimensionCode?.trim() || '(blank)')} is not one of this company's ${GRAIN_LABEL[grain]} members.`);
        continue;
      }
      memberId = member.id;
    }
    const bad = line.amounts.filter((a) => a.cell.kind === 'error');
    for (const a of bad) if (a.cell.kind === 'error') error(a.month, a.cell.raw === '' ? clip(a.cell.reason, 160) : `"${clip(a.cell.raw)}": ${clip(a.cell.reason, 120)}`);
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

  // A row key twice: neither copy is known to be the one meant, so every copy is left out.
  const rowsOf = new Map<string, number[]>();
  for (const r of resolved) {
    const at = rowsOf.get(r.rowKey);
    if (at) at.push(r.line.row); else rowsOf.set(r.rowKey, [r.line.row]);
  }
  const unique = resolved.filter((r) => {
    const at = rowsOf.get(r.rowKey)!;
    if (at.length === 1) return true;
    const others: number[] = [];
    for (const n of at) { if (n !== r.line.row) others.push(n); if (others.length === OTHERS_SHOWN) break; }
    const more = at.length - 1 - others.length;
    errors.push({
      row: r.line.row, column: COLUMN.accountCode,
      message: `${clip(r.account.code)}${r.line.dimensionCode ? ` / ${clip(r.line.dimensionCode)}` : ''} appears more than once (also on row ${others.join(', ')}${more > 0 ? ` and ${more} more` : ''}).`,
    });
    return false;
  });
  errors.sort((a, b) => a.row - b.row);
  return { rows: unique, errors, warnings };
}

/** `_base`'s rows by the cell-key row their codes resolve to now; a row resolving to nothing is skipped, one resolving twice is a forgery. */
export function baseByRowKey(model: GridReadModel, grain: TemplateGrain, base: readonly BaseLine[]): Map<string, ReadonlyArray<number | null>> {
  const find = finders(model, grain);
  const out = new Map<string, ReadonlyArray<number | null>>();
  for (const b of base) {
    const account = find.account(b.accountCode);
    if (!account) continue;
    let memberId: string | null = null;
    if (grain !== 'company') {
      const member = find.member(b.dimensionCode ?? '');
      if (!member) continue;
      memberId = member.id;
    }
    const key = templateRowKey(account.id, grain, memberId);
    if (out.has(key)) return tampered();
    out.set(key, b.cents);
  }
  return out;
}
