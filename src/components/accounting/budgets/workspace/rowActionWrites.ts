/**
 * What each data-changing row action writes (spec §5.5, §6.5, §11), as `{key, cents}` lists the
 * store applies as ONE undo entry. Pure: the arithmetic is PR-A's `spread.ts` (residue on the
 * last month / last sub-account, decision 5); this file only maps it onto cell keys.
 */
import type { CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { parseKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { type RoundingUnit, divRoundHalfAway, isCents } from '@/modules/accounting/services/budgets/grid/cents';
import { spreadEven } from '@/modules/accounting/services/budgets/grid/spread';

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

export type ShareResult = { ok: true; shares: number[] } | { ok: false; reason: string };

/**
 * `totalCents` split across `n` children (any n ≥ 1; PR-A's spreads stop at 15 months on purpose):
 * evenly, or by `weights` (PY share, one-signed, not all zero). Every share but the LAST is rounded
 * half away from zero to the unit; the last takes the residue, so Σ shares = total exactly (decision 5).
 */
export function splitShares(totalCents: number, n: number, unit: RoundingUnit, weights: readonly number[] | null = null): ShareResult {
  if (!Number.isInteger(n) || n < 1) return { ok: false, reason: 'There is nothing to spread across.' };
  if (!isCents(totalCents)) return { ok: false, reason: `Not a budget amount in cents: ${totalCents}.` };
  if (weights !== null) {
    if (weights.length !== n || !weights.every(Number.isSafeInteger)) return { ok: false, reason: 'One prior-year amount per sub-account is needed.' };
    if (weights.some(w => w > 0) && weights.some(w => w < 0)) return { ok: false, reason: 'The sub-accounts\' prior-year amounts have mixed signs, so they give no shares.' };
    if (weights.every(w => w === 0)) return { ok: false, reason: 'The sub-accounts have no prior-year actuals.' };
  }
  const step = BigInt(unit * 100);
  const total = BigInt(totalCents);
  const wSum = weights === null ? BigInt(n) : weights.reduce((s, w) => s + BigInt(w), 0n);
  const shares: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    const w = weights === null ? 1n : BigInt(weights[i]!);
    shares.push(Number(divRoundHalfAway(total * w, wSum * step) * step));
  }
  shares.push(totalCents - shares.reduce((s, x) => s + x, 0));
  if (!shares.every(isCents)) return { ok: false, reason: 'The result is larger than the biggest amount a budget month can hold.' };
  return { ok: true, shares: shares.map(x => (x === 0 ? 0 : x)) };
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
  let shares: ShareResult;
  if (mode === 'py') {
    const weights = children.map(ch => (ch.py === null ? 0 : month === null ? ch.py.reduce((s, c) => s + c, 0) : ch.py[month] ?? 0));
    if (weights.every(w => w === 0)) {
      note = 'The sub-accounts have no prior-year actuals, so the amount was spread evenly.';
      shares = splitShares(totalCents, children.length, unit);
    } else {
      shares = splitShares(totalCents, children.length, unit, weights);
    }
  } else {
    shares = splitShares(totalCents, children.length, unit);
  }
  if (!shares.ok) return shares;
  const perChild: number[][] = [];
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const share = shares.shares[i] ?? 0;
    if (month !== null) {
      perChild.push(Array.from({ length: monthCount }, (_, m) => (m === month ? share : child.values[m] ?? 0)));
      continue;
    }
    const spread = spreadEven(share, monthCount, unit);
    if (!spread.ok) return spread;
    perChild.push(spread.months);
  }
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
