/**
 * Import diff (spec §9.2) and the 409 rebase (spec §7.3). Blank clears, 0 is a
 * budgeted zero, a key absent from the file is untouched. Invariant 3: exporting
 * a version and importing the same file is zero changes.
 */
import { describe, it, expect } from 'vitest';
import { diffCells, gridOf, rebaseDirty } from '@/modules/accounting/services/budgets/grid/diff';

const k = (acc: string, m: string) => `${acc}||||${m}`;
const MONTHS = ['2027-03', '2027-04'];

const base = new Map<string, number | null>([
  [k('a', '2027-03'), 1000],
  [k('a', '2027-04'), 0],
  [k('b', '2027-03'), 500],
]);

describe('diffCells', () => {
  it('blank clears, 0 is a budgeted zero, absent keys are untouched', () => {
    const incoming = new Map<string, number | null>([
      [k('a', '2027-03'), null],
      [k('a', '2027-04'), 0],
      [k('c', '2027-03'), 0],
      [k('c', '2027-04'), null],
    ]);
    const d = diffCells(base, incoming, 'import');
    expect(d.changes).toEqual([
      { key: k('a', '2027-03'), before: 1000, after: null },
      { key: k('c', '2027-03'), before: null, after: 0 },
    ]);
    expect(d.counts).toEqual({ added: 1, changed: 0, cleared: 1, unchanged: 2 });
  });

  it('counts a changed value', () => {
    const d = diffCells(base, new Map([[k('b', '2027-03'), 750]]), 'import');
    expect(d.changes).toEqual([{ key: k('b', '2027-03'), before: 500, after: 750 }]);
    expect(d.counts.changed).toBe(1);
  });

  it('a null in the base is not budgeted', () => {
    const d = diffCells(new Map([[k('a', '2027-03'), null]]), new Map([[k('a', '2027-03'), null]]), 'import');
    expect(d.changes).toEqual([]);
  });

  it('invariant 3: export → import of the same file is zero changes', () => {
    const exported = gridOf(['a|||', 'b|||', 'z|||'], MONTHS, base);
    expect(exported.get(k('z', '2027-04'))).toBeNull();
    expect(exported.get(k('a', '2027-04'))).toBe(0);
    const d = diffCells(base, exported, 'import');
    expect(d.changes).toEqual([]);
    expect(d.counts).toEqual({ added: 0, changed: 0, cleared: 0, unchanged: 6 });
  });
});

describe('rebaseDirty (409: reload and re-apply mine)', () => {
  const original = new Map<string, number | null>([[k('a', '2027-03'), 100], [k('a', '2027-04'), 200]]);

  it('applies my edits over the fresh version; a key changed under me is a conflict', () => {
    const fresh = new Map<string, number | null>([[k('a', '2027-03'), 150], [k('a', '2027-04'), 200], [k('b', '2027-03'), 9]]);
    const dirty = new Map<string, number | null>([[k('a', '2027-03'), 300], [k('a', '2027-04'), 250]]);
    const r = rebaseDirty(original, fresh, dirty);
    expect(r.conflicts).toEqual([k('a', '2027-03')]);
    expect(r.values.get(k('a', '2027-03'))).toBe(300);
    expect(r.values.get(k('a', '2027-04'))).toBe(250);
    expect(r.values.get(k('b', '2027-03'))).toBe(9);
    expect([...r.dirty.keys()]).toEqual([k('a', '2027-03'), k('a', '2027-04')]);
  });

  it('a key deleted under me is a conflict; my clear of it is not dirty any more', () => {
    const fresh = new Map<string, number | null>([[k('a', '2027-04'), 200]]);
    const r = rebaseDirty(original, fresh, new Map([[k('a', '2027-03'), null]]));
    expect(r.conflicts).toEqual([k('a', '2027-03')]);
    expect(r.dirty.size).toBe(0);
    expect(r.values.get(k('a', '2027-03'))).toBeNull();
  });

  it('no conflicts when nobody touched my cells', () => {
    const r = rebaseDirty(original, new Map(original), new Map([[k('a', '2027-04'), 1]]));
    expect(r.conflicts).toEqual([]);
    expect(r.dirty.get(k('a', '2027-04'))).toBe(1);
  });
});
