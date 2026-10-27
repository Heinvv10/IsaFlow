/**
 * Row-action write lists (spec §5.5, §6.5, §11): what spreading a row, splitting a header across
 * its sub-accounts, moving a legacy header's own amounts and changing an account's grain write.
 * Each is ONE list the store applies as one undo entry; the maths is PR-A's spread.ts.
 */
import { describe, it, expect } from 'vitest';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import {
  childWrites, clearWrites, grainChangeWrites, moveWrites, rowWrites, splitAcrossChildren, type ChildShare,
} from '@/components/accounting/budgets/workspace/rowActionWrites';

const MONTHS = ['2026-03', '2026-04', '2026-05'];
const k = (acct: string, m: number, cc1Id: string | null = null) =>
  cellKey({ glAccountId: acct, cc1Id, cc2Id: null, buId: null, month: MONTHS[m]! });
const keys = (acct: string, cc1Id: string | null = null) => MONTHS.map((_, i) => k(acct, i, cc1Id));
const child = (id: string, values: (number | null)[], py: number[] | null = null): ChildShare => ({ accountId: id, keys: keys(id), values, py });

describe('rowWrites / clearWrites', () => {
  it('zips keys with months; clearing writes null only where a value is held', () => {
    expect(rowWrites(keys('a'), [1, 2, 3])).toEqual([{ key: k('a', 0), cents: 1 }, { key: k('a', 1), cents: 2 }, { key: k('a', 2), cents: 3 }]);
    expect(clearWrites(keys('a'), [5, null, 0])).toEqual([{ key: k('a', 0), cents: null }, { key: k('a', 2), cents: null }]);
  });
});

describe('splitAcrossChildren', () => {
  it('FY evenly: residue on the last child, each child spread over the months, Σ = target to the cent', () => {
    const r = splitAcrossChildren(1000_00, [child('a', [null, null, null]), child('b', [null, null, null]), child('c', [null, null, null])], 'even', null, 3, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const fys = r.perChild.map(m => m.reduce((s, x) => s + x, 0));
    expect(fys).toEqual([333_00, 333_00, 334_00]);
    expect(r.perChild[2]).toEqual([111_00, 111_00, 112_00]);
    expect(fys.reduce((s, x) => s + x, 0)).toBe(1000_00);
  });

  it('by PY share; all-zero PY falls back to evenly and says so', () => {
    const byPy = splitAcrossChildren(900_00, [child('a', [null, null, null], [100, 0, 0]), child('b', [null, null, null], [200, 0, 0])], 'py', null, 3, 1);
    expect(byPy.ok && byPy.perChild.map(m => m.reduce((s, x) => s + x, 0))).toEqual([300_00, 600_00]);
    const zero = splitAcrossChildren(900_00, [child('a', [null, null, null], [0, 0, 0]), child('b', [null, null, null], null)], 'py', null, 3, 1);
    expect(zero.ok && zero.note).toMatch(/spread evenly/);
    expect(zero.ok && zero.perChild.map(m => m.reduce((s, x) => s + x, 0))).toEqual([450_00, 450_00]);
  });

  it('a month split touches only that month', () => {
    const kids = [child('a', [7, null, 9]), child('b', [null, null, null])];
    const r = splitAcrossChildren(100_00, kids, 'even', 1, 3, 1);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(childWrites(kids, r.perChild, 1)).toEqual([{ key: k('a', 1), cents: 50_00 }, { key: k('b', 1), cents: 50_00 }]);
  });

  it('refuses no children; more than 15 children split fine (N unbounded)', () => {
    expect(splitAcrossChildren(1, [], 'even', null, 3, 1)).toMatchObject({ ok: false });
    const many = Array.from({ length: 40 }, (_, i) => child(`c${i}`, [null, null, null]));
    const r = splitAcrossChildren(4000_00, many, 'even', 0, 3, 1);
    expect(r.ok && r.perChild.map(m => m[0])).toEqual(Array(40).fill(100_00));
  });
});

describe('splitAcrossChildren: residue across zero', () => {
  const kids = (n: number) => Array.from({ length: n }, (_, i) => child(`k${i}`, [null, null, null]));
  it('flags a last sub-account the unit pushed across zero (R160 over 3 at R100: 100, 100, −40)', () => {
    const r = splitAcrossChildren(160_00, kids(3), 'even', 0, 3, 100);
    expect(r.ok && r.perChild.map(m => m[0])).toEqual([100_00, 100_00, -40_00]);
    expect(r.ok && r.note).toMatch(/other side of zero/);
  });
  it('flags a sub-account whose month spread ends across zero (each R1 800 over 12 at R100)', () => {
    const twelve = Array.from({ length: 2 }, (_, i) => ({ accountId: `k${i}`, keys: Array.from({ length: 12 }, () => k('x', 0)), values: Array(12).fill(null), py: null }));
    const r = splitAcrossChildren(3600_00, twelve, 'even', null, 12, 100);
    expect(r.ok && r.note).toMatch(/other side of zero/);
  });
  it('no note when nothing crosses zero', () => {
    const r = splitAcrossChildren(300_00, kids(3), 'even', 0, 3, 100);
    expect(r.ok && r.note).toBeNull();
  });
});

describe('moveWrites', () => {
  it('clears the header and adds its amounts to what the child holds', () => {
    expect(moveWrites(keys('h'), [10, null, 5], keys('c'), [1, 2, null])).toEqual([
      { key: k('h', 0), cents: null }, { key: k('h', 2), cents: null },
      { key: k('c', 0), cents: 11 }, { key: k('c', 2), cents: 5 },
    ]);
  });
});

describe('grainChangeWrites', () => {
  const held = [[k('x', 0, 'm1'), 10], [k('x', 0, 'm2'), 20], [k('x', 2, 'm1'), 5]] as const;
  it('clears every held cell and carries the per-month totals onto the new grain in the same batch', () => {
    const r = grainChangeWrites(held, MONTHS, keys('x'), true);
    expect(r).toMatchObject({ clearedCents: 35, clearedMonths: 2 });
    expect(r.writes).toEqual([
      { key: k('x', 0, 'm1'), cents: null }, { key: k('x', 0, 'm2'), cents: null }, { key: k('x', 2, 'm1'), cents: null },
      { key: k('x', 0), cents: 30 }, { key: k('x', 2), cents: 5 },
    ]);
  });
  it('without carry it only clears', () => {
    expect(grainChangeWrites(held, MONTHS, keys('x'), false).writes.every(w => w.cents === null)).toBe(true);
  });
});

