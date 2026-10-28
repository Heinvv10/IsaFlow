/**
 * Pure pieces of the grid store (`gridStore.ts`): header roll-ups, prior-actual and compare
 * series per account for a view, and the per-row selection slice. No React, no state.
 */
import type { GridAccount, GridCell } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { PriorActuals } from '@/modules/accounting/services/budgets/priorActuals';
import { type CellKey, cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import type { GridState } from '@/modules/accounting/services/budgets/grid/keyboard';
import type { View } from '@/modules/accounting/services/budgets/grid/pivot';
import { normalise } from '@/modules/accounting/services/budgets/grid/selection';
import type { GridRowSnapshot } from './types';

export type Series = readonly (number | null)[];

export const sameSeries = (a: Series, b: Series): boolean => a.length === b.length && a.every((v, i) => v === b[i]);

/** Σ of the non-null entries; null when every entry is null. */
export function sumOf(xs: Series): number | null {
  let total: number | null = null;
  for (const v of xs) if (v !== null) total = (total ?? 0) + v;
  return total;
}

/** Month-wise Σ of `parts`; a month is null when no part has a value there. */
export function addSeries(n: number, parts: readonly Series[]): (number | null)[] {
  const out = Array<number | null>(n).fill(null);
  for (const p of parts) for (let m = 0; m < n; m++) { const v = p[m]; if (v !== null && v !== undefined) out[m] = (out[m] ?? 0) + v; }
  return out;
}

/** Headers deepest first, so a nested header's roll-up exists before its parent's is summed. */
export const headersDeepestFirst = (accounts: Iterable<GridAccount>): GridAccount[] =>
  [...accounts].filter(a => a.isHeader).sort((a, b) => b.depth - a.depth);

/** The headers above `account`, nearest first (a parent cycle stops at the repeat). */
export function ancestorsOf(account: GridAccount, byId: ReadonlyMap<string, GridAccount>): string[] {
  const out: string[] = [];
  const seen = new Set<string>([account.id]);
  for (let p = account.parentId; p !== null && !seen.has(p); p = byId.get(p)?.parentId ?? null) {
    seen.add(p);
    out.push(p);
  }
  return out;
}

/**
 * A header's roll-up: Σ over its sub-accounts of their own series plus, for a sub-header, its
 * roll-up (the read model's definition: every listed account below it, its own amounts excluded).
 */
export function rollupOf(header: GridAccount, n: number, own: (id: string) => Series, rollups: ReadonlyMap<string, Series>): (number | null)[] {
  const parts: Series[] = [];
  for (const child of header.childIds) {
    parts.push(own(child));
    const nested = rollups.get(child);
    if (nested) parts.push(nested);
  }
  return addSeries(n, parts);
}

/** Wire cells → cents by key. */
export function cellsInCents(cells: readonly GridCell[]): Map<CellKey, number | null> {
  return new Map(cells.map(c => [cellKey(c), toCents(c.amount)] as const));
}

/** Cells grouped by account (a key's account is its first part). */
export function byAccount(cells: ReadonlyMap<CellKey, number | null>): Map<string, Map<CellKey, number | null>> {
  const out = new Map<string, Map<CellKey, number | null>>();
  for (const [k, v] of cells) {
    const acct = k.slice(0, k.indexOf('|'));
    let m = out.get(acct);
    if (!m) { m = new Map(); out.set(acct, m); }
    m.set(k, v);
  }
  return out;
}

/** PY per account for `view`, cents per month; null when `prior` is not this view's grain. */
export function priorFor(prior: PriorActuals | null, view: View, months: readonly string[]): Map<string, number[]> | null {
  if (!prior || prior.grain !== view.kind) return null;
  const member = view.kind === 'company' ? null : view.memberId;
  const index = new Map(prior.months.map((m, i) => [m, i]));
  const out = new Map<string, number[]>();
  for (const c of prior.cells) {
    if (c.dimensionId !== member) continue;
    const i = index.get(c.month);
    if (i === undefined || i >= months.length) continue;
    const series = out.get(c.glAccountId) ?? Array<number>(months.length).fill(0);
    series[i] = (series[i] ?? 0) + toCents(c.amount);
    out.set(c.glAccountId, series);
  }
  return out;
}

type SelectionPart = Pick<GridRowSnapshot, 'focusCol' | 'selected' | 'editing'>;

export function selectionPart(state: GridState, r: number): SelectionPart {
  const rect = normalise(state.anchor, state.focus);
  const onFocus = state.focus.r === r;
  return {
    focusCol: onFocus ? state.focus.c : null,
    selected: r >= rect.top && r <= rect.bottom ? { left: rect.left, right: rect.right } : null,
    editing: onFocus && state.mode === 'edit' ? { col: state.focus.c, draft: state.draft } : null,
  };
}

export function sameSelection(a: SelectionPart, b: SelectionPart): boolean {
  return a.focusCol === b.focusCol
    && a.selected?.left === b.selected?.left && a.selected?.right === b.selected?.right
    && a.editing?.col === b.editing?.col && a.editing?.draft === b.editing?.draft;
}

/** Row indexes whose selection slice can differ between two states. */
export function touchedRows(prev: GridState, next: GridState): Set<number> {
  const out = new Set<number>([prev.focus.r, next.focus.r]);
  for (const s of [prev, next]) {
    const rect = normalise(s.anchor, s.focus);
    for (let r = rect.top; r <= rect.bottom; r++) out.add(r);
  }
  return out;
}
