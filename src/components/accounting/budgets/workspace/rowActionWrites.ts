/**
 * What each data-changing row action writes (spec §5.5, §6.5, §11), as `{key, cents}` lists the
 * store applies as ONE undo entry. Pure: the arithmetic is PR-A's `spread.ts` (residue on the
 * last month / last sub-account, decision 5); this file only maps it onto cell keys.
 */
import type { CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { parseKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import { type SplitResult, residueFlipsSign, splitByWeights, spreadEven } from '@/modules/accounting/services/budgets/grid/spread';

export interface CellWriteByKey { key: CellKey; cents: number | null }

/** One row's month keys (current view) zipped with the spread result. */
export function rowWrites(keys: readonly CellKey[], months: readonly (number | null)[]): CellWriteByKey[] {
  return keys.map((key, i) => ({ key, cents: months[i] ?? null }));
}

export interface ChildShare {
  accountId: string;
  /** The child's month keys in the current view. */
  keys: readonly CellKey[];
  /** Current cents per month (null = not budgeted). */
  values: readonly (number | null)[];
  /** PY actual per month, null when not loaded. */
  py: readonly number[] | null;
}

export type ChildSplit =
  | { ok: true; perChild: number[][]; note: string | null }
  | { ok: false; reason: string };

/**
 * Splits `totalCents` across sub-accounts, evenly or in proportion to their PY (falls back to
 * evenly when the PY is all zero, as spec §6.5 says). `month` = one month index; null = the FY,
 * which each child then spreads evenly over the months.
 */
export function splitAcrossChildren(
  totalCents: number, children: readonly ChildShare[], mode: 'even' | 'py', month: number | null,
  monthCount: number, unit: RoundingUnit,
): ChildSplit {
  if (children.length === 0) return { ok: false, reason: 'This header has no sub-accounts.' };
  let note: string | null = null;
  let shares: SplitResult;
  if (mode === 'py') {
    const weights = children.map(ch => (ch.py === null ? 0 : month === null ? ch.py.reduce((s, c) => s + c, 0) : ch.py[month] ?? 0));
    if (weights.every(w => w === 0)) {
      note = 'The sub-accounts have no prior-year actuals, so the amount was spread evenly.';
      shares = splitByWeights(totalCents, children.length, unit);
    } else {
      shares = splitByWeights(totalCents, weights, unit);
    }
  } else {
    shares = splitByWeights(totalCents, children.length, unit);
  }
  if (!shares.ok) return shares;
  let crossed = residueFlipsSign(totalCents, shares.parts);
  const perChild: number[][] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const share = shares.parts[i] ?? 0;
    if (month !== null) {
      perChild.push(Array.from({ length: monthCount }, (_, m) => (m === month ? share : child.values[m] ?? 0)));
      continue;
    }
    const spread = spreadEven(share, monthCount, unit);
    if (!spread.ok) return spread;
    if (residueFlipsSign(share, spread.months)) crossed = true;
    perChild.push(spread.months);
  }
  if (crossed) note = [note, `The R${unit} rounding puts a last part on the other side of zero; a smaller rounding unit avoids it.`].filter(Boolean).join(' ');
  return { ok: true, perChild, note };
}

/** Writes for a children split; a month split leaves the other months untouched. */
export function childWrites(children: readonly ChildShare[], perChild: readonly number[][], month: number | null): CellWriteByKey[] {
  const out: CellWriteByKey[] = [];
  children.forEach((ch, i) => {
    ch.keys.forEach((key, m) => {
      if (month !== null && m !== month) return;
      out.push({ key, cents: perChild[i]?.[m] ?? 0 });
    });
  });
  return out;
}

/** Clears for every non-null cell of a row (a legacy header's own amounts, a cleared row). */
export function clearWrites(keys: readonly CellKey[], values: readonly (number | null)[]): CellWriteByKey[] {
  return keys.flatMap((key, m) => (values[m] === null || values[m] === undefined ? [] : [{ key, cents: null }]));
}

/** A legacy header's own amounts moved onto one child, added to what the child holds (band total unchanged). */
export function moveWrites(
  ownKeys: readonly CellKey[], ownValues: readonly (number | null)[],
  childKeys: readonly CellKey[], childValues: readonly (number | null)[],
): CellWriteByKey[] {
  const out = clearWrites(ownKeys, ownValues);
  ownValues.forEach((v, m) => {
    const key = childKeys[m];
    if (v === null || v === undefined || key === undefined) return;
    out.push({ key, cents: (childValues[m] ?? 0) + v });
  });
  return out;
}

export interface GrainChange {
  writes: CellWriteByKey[];
  clearedCents: number;
  clearedMonths: number;
}

/**
 * One batch for "Budget by CC1… / at company level…" (§11): clear every non-null cell the account
 * holds at its old grain, then (when `carry`) write its per-month total onto the new grain's keys.
 */
export function grainChangeWrites(
  held: readonly (readonly [CellKey, number])[], months: readonly string[],
  newKeys: readonly CellKey[], carry: boolean,
): GrainChange {
  const perMonth = months.map(() => 0);
  const touched = new Set<number>();
  const monthIndex = new Map(months.map((m, i) => [m, i]));
  for (const [key, v] of held) {
    const i = monthIndex.get(parseKey(key).month);
    if (i === undefined) continue;
    perMonth[i] = (perMonth[i] ?? 0) + v;
    touched.add(i);
  }
  const writes: CellWriteByKey[] = held.map(([key]) => ({ key, cents: null }));
  if (carry) {
    for (const i of touched) {
      const key = newKeys[i];
      if (key !== undefined) writes.push({ key, cents: perMonth[i] ?? 0 });
    }
  }
  return { writes, clearedCents: held.reduce((s, [, v]) => s + v, 0), clearedMonths: touched.size };
}
