/**
 * The dimension pivot (spec §11, decision 4). The grid shows one row per
 * account in every view; this decides each row's values and whether it is
 * editable there. An account is edited only at its own grain. Anywhere else it
 * is read-only with a reason, and the Company view of a dimension-grain account
 * is the computed roll-up (Σ of its dimension rows; invariant 2).
 *
 * The grain comes from the current values (a cleared cell, `null`, carries no
 * grain), so the first write in a dimension view makes the account that grain.
 */
import { type CellKey, type Dimension, cellKey, grainOf, parseKey } from './cellKey';

export type View = { kind: 'company' } | { kind: Dimension; memberId: string };
export type AccountGrain = 'company' | Dimension | 'mixed';

export interface PivotInput {
  accountIds: readonly string[];
  /** The year's months, 'YYYY-MM', in column order. */
  months: readonly string[];
  /** Cents; null = cleared (not budgeted). */
  cells: ReadonlyMap<CellKey, number | null>;
  locked?: boolean;
  canWrite?: boolean;
}

export interface PivotRow {
  values: (number | null)[];
  editable: boolean;
  readReason?: string;
}

const DIM_LABEL: Record<Dimension, string> = { cc1: 'CC1', cc2: 'CC2', bu: 'BU' };
const MIXED_REASON = 'Budgeted at more than one grain: edit via Excel';

/** Each account's grain, from its non-null cells. Accounts with none are absent ("none"). */
export function accountGrains(cells: ReadonlyMap<CellKey, number | null>): Map<string, AccountGrain> {
  const out = new Map<string, AccountGrain>();
  for (const [key, v] of cells) {
    if (v === null) continue;
    const ref = parseKey(key);
    const g = grainOf(ref);
    const grain: AccountGrain = g === 'multi' ? 'mixed' : g;
    const seen = out.get(ref.glAccountId);
    out.set(ref.glAccountId, seen === undefined || seen === grain ? grain : 'mixed');
  }
  return out;
}

const dimId = (ref: ReturnType<typeof parseKey>, d: Dimension): string | null =>
  d === 'cc1' ? ref.cc1Id : d === 'cc2' ? ref.cc2Id : ref.buId;

/** The cell a write lands on for `accountId` × `month` in `view`. */
export function viewCellKey(accountId: string, view: View, month: string): CellKey {
  const memberOf = (d: Dimension) => (view.kind === d ? view.memberId : null);
  return cellKey({ glAccountId: accountId, cc1Id: memberOf('cc1'), cc2Id: memberOf('cc2'), buId: memberOf('bu'), month });
}

function rowFor(grain: AccountGrain | undefined, view: View): { mode: 'own' | 'rollup' | 'blank'; reason?: string } {
  if (view.kind === 'company') {
    if (grain === undefined || grain === 'company') return { mode: 'own' };
    if (grain === 'mixed') return { mode: 'rollup', reason: MIXED_REASON };
    return { mode: 'rollup', reason: `Roll-up of ${DIM_LABEL[grain]}, switch view to edit` };
  }
  if (grain === undefined || grain === view.kind) return { mode: 'own' };
  if (grain === 'company') return { mode: 'blank', reason: 'Budgeted at company level' };
  if (grain === 'mixed') return { mode: 'blank', reason: MIXED_REASON };
  return { mode: 'blank', reason: `Budgeted by ${DIM_LABEL[grain]}` };
}

export function resolveView(input: PivotInput, view: View, grains = accountGrains(input.cells)): Map<string, PivotRow> {
  const monthIndex = new Map(input.months.map((m, i) => [m, i]));
  const rollups = new Map<string, (number | null)[]>();
  for (const [key, v] of input.cells) {
    if (v === null) continue;
    const ref = parseKey(key);
    const i = monthIndex.get(ref.month);
    if (i === undefined) continue;
    const sums = rollups.get(ref.glAccountId) ?? Array<number | null>(input.months.length).fill(null);
    sums[i] = (sums[i] ?? 0) + v;
    rollups.set(ref.glAccountId, sums);
  }

  const out = new Map<string, PivotRow>();
  for (const id of input.accountIds) {
    const { mode, reason } = rowFor(grains.get(id), view);
    let values: (number | null)[];
    if (mode === 'rollup') values = rollups.get(id) ?? input.months.map(() => null);
    else if (mode === 'blank') values = input.months.map(() => null);
    else values = input.months.map(m => input.cells.get(viewCellKey(id, view, m)) ?? null);
    const readReason = input.locked ? 'Locked version' : input.canWrite === false ? 'Read-only access' : reason;
    out.set(id, readReason ? { values, editable: false, readReason } : { values, editable: true });
  }
  return out;
}

/** FY profit contribution per member of `dim` (for the member picker): Σ sign(account) × amount. */
export function memberTotals(
  cells: ReadonlyMap<CellKey, number | null>, dim: Dimension, signOf: (accountId: string) => number,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, v] of cells) {
    if (v === null) continue;
    const ref = parseKey(key);
    const member = dimId(ref, dim);
    if (member === null) continue;
    out.set(member, (out.get(member) ?? 0) + signOf(ref.glAccountId) * v);
  }
  return out;
}
