/**
 * The workspace grid store (spec §4.4, §5.5, §5.6, §11, §13): values in cents, dirty against what
 * was loaded or saved, one undo entry per action, per-row and per-metric subscriptions (one edit
 * notifies its row, its header roll-ups and the metrics it moved, nothing else), live subtotals
 * equal to PR-A's `foldBands`, and the dimension pivot through PR-A's `resolveView`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GridStore, accountRowKey, rollupRowKey } from '@/components/accounting/budgets/workspace/gridStore';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { toCents } from '@/modules/accounting/services/budgets/grid/cents';
import { foldBands, type Metric } from '@/modules/accounting/services/budgets/grid/subtotals';
import { initialGridState } from '@/modules/accounting/services/budgets/grid/keyboard';
import { ID, MONTHS, gridModel } from './gridFixture';

const key = (acct: string, m: number, cc1Id: string | null = null) =>
  cellKey({ glAccountId: acct, cc1Id, cc2Id: null, buId: null, month: MONTHS[m]! });
const COMPANY = { kind: 'company' } as const;

let store: GridStore;
beforeEach(() => {
  store = new GridStore();
  store.reset(gridModel(), { view: COMPANY, canWrite: true });
});

function lineIndex(rowKey: string): number {
  const row = store.getLayout().rows.find(r => r.key === rowKey);
  if (!row) throw new Error(`no row ${rowKey}`);
  return row.index;
}

describe('layout', () => {
  it('orders bands with section, lines, total, and GP / OP / NP in reconciling order', () => {
    const keys = store.getLayout().rows.map(r => r.key);
    expect(keys).toEqual([
      'section:turnover', accountRowKey(ID.rev1), accountRowKey(ID.rev2), 'total:turnover',
      'section:cost_of_sales', accountRowKey(ID.cos1), 'total:cost_of_sales',
      'profit:grossProfit',
      'section:operating_expense', rollupRowKey(ID.hdr), accountRowKey(ID.kid1), accountRowKey(ID.kid2),
      accountRowKey(ID.opex), accountRowKey(ID.dimAcc), 'total:operating_expense',
      'profit:operatingProfit',
      'section:other_expense', accountRowKey(ID.oexp), 'total:other_expense',
      'profit:netProfit',
    ]);
    const layout = store.getLayout();
    expect(layout.cols).toBe(13);
    expect(layout.rowKinds[layout.rows.length - 1]).toBe('grand');
    expect(layout.rows.every((r, i) => r.index === i)).toBe(true);
  });
});

describe('values and subtotals', () => {
  it('holds cents per month, null where not budgeted, 0 where budgeted zero', () => {
    const row = store.getRow(accountRowKey(ID.rev1));
    expect(row.values.slice(0, 3)).toEqual([100000, 0, null]);
    expect(row.fy).toBe(100000);
    expect(store.getRow(accountRowKey(ID.rev2)).fy).toBeNull();
  });

  it('subtotals equal foldBands over the rows (header roll-ups never counted)', () => {
    // A changed value (rev1), a new one (rev2) and one in another band: the band sums move by the difference.
    store.apply([{ key: key(ID.rev1, 0), cents: 5 }, { key: key(ID.rev2, 2), cents: 7_00 }, { key: key(ID.oexp, 3), cents: 3_00 }]);
    const lines = gridModel().accounts.map(a => ({ band: a.band, values: store.getRow(accountRowKey(a.id))?.values ?? [] }));
    const expected = foldBands(lines, r => r.values, MONTHS.length);
    for (const m of Object.keys(expected.fy) as Metric[]) {
      expect(store.getTotal(m).months).toEqual(expected.months[m]);
      expect(store.getTotal(m).fy).toBe(expected.fy[m]);
    }
    expect(store.getTotal('grossProfit').fy).toBe(5 + 700 - 40000);
    expect(store.getTotal('operatingExpenses').fy).toBe(5050 + 3000);
  });

  it('a header row is the live Σ of its sub-accounts, read-only', () => {
    expect(store.getRow(rollupRowKey(ID.hdr)).values[0]).toBe(5050);
    store.apply([{ key: key(ID.kid2, 0), cents: 950 }]);
    const hdr = store.getRow(rollupRowKey(ID.hdr));
    expect(hdr.values[0]).toBe(6000);
    expect(hdr.editable).toBe(false);
    expect(hdr.readReason).toBe('Sub-account roll-up');
  });
});

describe('header roll-up parity with the read model (R5)', () => {
  it('on load, every header roll-up row equals the server\'s GridAccount.rollup (rand → cents; null months are 0)', () => {
    const headers = gridModel().accounts.filter(a => a.isHeader);
    expect(headers.length).toBeGreaterThan(0);
    for (const h of headers) {
      const server = (h.rollup ?? []).map(toCents);
      const client = store.getRow(rollupRowKey(h.id)).values.map(v => v ?? 0);
      expect(client).toEqual(server);
      expect(server.some(v => v !== 0)).toBe(true); // a fixture of zeros would prove nothing
    }
  });
});

describe('subscriptions', () => {
  it('one edit notifies only its row, the header above it and the metrics it changed', () => {
    const rows = store.getLayout().rows.filter(r => r.kind === 'line');
    const rowSpies = new Map(rows.map(r => [r.key, vi.fn()]));
    for (const [k, spy] of rowSpies) store.subscribeRow(k, spy);
    const metrics: Metric[] = ['turnover', 'costOfSales', 'grossProfit', 'otherIncome', 'operatingExpenses', 'operatingProfit', 'otherExpenses', 'netProfit'];
    const totalSpies = new Map(metrics.map(m => [m, vi.fn()]));
    for (const [m, spy] of totalSpies) store.subscribeTotal(m, spy);

    store.apply([{ key: key(ID.kid2, 4), cents: 1_00 }]);

    const notifiedRows = [...rowSpies].filter(([, s]) => s.mock.calls.length > 0).map(([k]) => k);
    expect(notifiedRows.sort()).toEqual([accountRowKey(ID.kid2), rollupRowKey(ID.hdr)].sort());
    const notifiedTotals = [...totalSpies].filter(([, s]) => s.mock.calls.length > 0).map(([m]) => m);
    expect(notifiedTotals.sort()).toEqual(['netProfit', 'operatingExpenses', 'operatingProfit']);
  });

  it('moving focus notifies only the row it left and the row it entered', () => {
    const a = lineIndex(accountRowKey(ID.rev1));
    const b = lineIndex(accountRowKey(ID.rev2));
    store.setGridState({ ...initialGridState(store.getShape()), focus: { r: a, c: 0 }, anchor: { r: a, c: 0 } });
    const spies = new Map(store.getLayout().rows.filter(r => r.kind === 'line').map(r => [r.key, vi.fn()]));
    for (const [k, spy] of spies) store.subscribeRow(k, spy);
    store.setGridState({ ...store.getGridState(), focus: { r: b, c: 0 }, anchor: { r: b, c: 0 } });
    const notified = [...spies].filter(([, s]) => s.mock.calls.length > 0).map(([k]) => k);
    expect(notified.sort()).toEqual([accountRowKey(ID.rev1), accountRowKey(ID.rev2)].sort());
    expect(store.getRow(accountRowKey(ID.rev2)).focusCol).toBe(0);
    expect(store.getRow(accountRowKey(ID.rev1)).focusCol).toBeNull();
  });

  it('an unchanged write notifies nobody and records no undo entry', () => {
    const spy = vi.fn();
    store.subscribeRow(accountRowKey(ID.rev1), spy);
    expect(store.apply([{ key: key(ID.rev1, 0), cents: 100000 }])).toBe(0);
    expect(spy).not.toHaveBeenCalled();
    expect(store.getMeta().canUndo).toBe(false);
  });

  it('a snapshot is a stable reference until it changes', () => {
    const before = store.getRow(accountRowKey(ID.rev2));
    store.apply([{ key: key(ID.rev1, 5), cents: 1 }]);
    expect(store.getRow(accountRowKey(ID.rev2))).toBe(before);
    expect(store.getTotal('costOfSales')).toBe(store.getTotal('costOfSales'));
  });
});

describe('dirty and undo', () => {
  it('a cell is dirty while it differs from the original; writing the original back un-dirties it', () => {
    store.apply([{ key: key(ID.rev1, 0), cents: 5 }]);
    expect(store.getRow(accountRowKey(ID.rev1)).dirty[0]).toBe(true);
    expect(store.getMeta().dirtyCount).toBe(1);
    store.apply([{ key: key(ID.rev1, 0), cents: 100000 }]);
    expect(store.getRow(accountRowKey(ID.rev1)).dirty[0]).toBe(false);
    expect(store.getMeta().dirtyCount).toBe(0);
  });

  it('a multi-cell write is one undo entry; undo restores every cell, redo re-applies', () => {
    store.apply([{ key: key(ID.rev2, 0), cents: 1 }, { key: key(ID.rev2, 1), cents: 2 }, { key: key(ID.rev1, 0), cents: null }]);
    expect(store.undo()).toBe(3);
    expect(store.getRow(accountRowKey(ID.rev2)).values.slice(0, 2)).toEqual([null, null]);
    expect(store.getRow(accountRowKey(ID.rev1)).values[0]).toBe(100000);
    expect(store.getMeta()).toMatchObject({ canUndo: false, canRedo: true, dirtyCount: 0 });
    expect(store.redo()).toBe(3);
    expect(store.getRow(accountRowKey(ID.rev1)).values[0]).toBeNull();
    expect(store.getMeta().dirtyCount).toBe(3);
  });

  it('dirtyMap carries a clear as null; markSaved keeps an edit made during the save dirty', () => {
    store.apply([{ key: key(ID.rev1, 0), cents: null }, { key: key(ID.rev2, 0), cents: 300 }]);
    const snapshot = store.dirtyMap();
    expect([...snapshot]).toEqual([[key(ID.rev1, 0), null], [key(ID.rev2, 0), 300]]);
    store.apply([{ key: key(ID.rev2, 0), cents: 400 }]); // typed while the save was in flight
    store.markSaved(snapshot);
    expect(store.getMeta().dirtyCount).toBe(1);
    expect(store.getRow(accountRowKey(ID.rev2)).dirty[0]).toBe(true);
    expect(store.getRow(accountRowKey(ID.rev1)).dirty[0]).toBe(false);
    // A save does not clear the stack; undo after it makes the cell dirty again.
    store.undo();
    expect(store.getRow(accountRowKey(ID.rev2)).values[0]).toBe(300);
    expect(store.getMeta().dirtyCount).toBe(0);
    store.undo();
    expect(store.getMeta().dirtyCount).toBe(2);
  });

  it('discard restores the original and clears undo and conflicts', () => {
    store.apply([{ key: key(ID.rev1, 0), cents: 1 }]);
    store.discard();
    expect(store.getRow(accountRowKey(ID.rev1)).values[0]).toBe(100000);
    expect(store.getMeta()).toMatchObject({ dirtyCount: 0, canUndo: false });
  });
});

describe('access and the dimension pivot', () => {
  it('a locked version or a viewer makes every row read-only with the reason', () => {
    store.reset(gridModel(), { view: COMPANY, canWrite: true, locked: true });
    expect(store.getRow(accountRowKey(ID.rev1))).toMatchObject({ editable: false, readReason: 'Locked version' });
    store.reset(gridModel(), { view: COMPANY, canWrite: false });
    expect(store.getRow(accountRowKey(ID.rev2))).toMatchObject({ editable: false, readReason: 'Read-only access' });
  });

  it('company view: a CC1-grain account is the read-only roll-up of its members', () => {
    const row = store.getRow(accountRowKey(ID.dimAcc));
    expect(row.values[0]).toBe(3000);
    expect(row.editable).toBe(false);
    expect(row.readReason).toMatch(/Roll-up of CC1/);
    expect(store.cellKeyAt({ r: lineIndex(accountRowKey(ID.dimAcc)), c: 0 })).toBe(key(ID.dimAcc, 0));
    expect(store.isEditable({ r: lineIndex(accountRowKey(ID.dimAcc)), c: 0 })).toBe(false);
  });

  it('CC1 view: company-grain accounts are read-only, the member row is editable, a first write takes the grain', () => {
    store.setView({ kind: 'cc1', memberId: ID.m2 });
    expect(store.getRow(accountRowKey(ID.rev1))).toMatchObject({ editable: false, readReason: 'Budgeted at company level' });
    expect(store.getRow(accountRowKey(ID.dimAcc))).toMatchObject({ editable: true });
    expect(store.getRow(accountRowKey(ID.dimAcc)).values[0]).toBe(2000);
    const r = lineIndex(accountRowKey(ID.rev2));
    expect(store.cellKeyAt({ r, c: 1 })).toBe(key(ID.rev2, 1, ID.m2));
    store.apply([{ key: key(ID.rev2, 1, ID.m2), cents: 900 }]);
    store.setView(COMPANY);
    expect(store.getRow(accountRowKey(ID.rev2))).toMatchObject({ editable: false });
    expect(store.getRow(accountRowKey(ID.rev2)).values[1]).toBe(900);
    // Dirty edits AND the undo stack survive a view switch: cell keys do not depend on the view
    // (deliberate deviation from §5.5, which cleared the stack behind a confirm).
    expect(store.getMeta()).toMatchObject({ dirtyCount: 1, canUndo: true });
    store.undo();
    expect(store.getRow(accountRowKey(ID.rev2)).values[1]).toBeNull();
    expect(store.getMeta().dirtyCount).toBe(0);
  });

  it('prior actuals follow the view: company grain, then the member of a dimension', () => {
    store.setPrior({ fiscalYear: 2027, grain: 'company', months: MONTHS, priorMonths: MONTHS, cells: [
      { glAccountId: ID.rev1, dimensionId: null, month: MONTHS[0]!, amount: 12.34 },
      { glAccountId: ID.rev1, dimensionId: null, month: MONTHS[2]!, amount: 1 },
    ] });
    expect(store.getRow(accountRowKey(ID.rev1)).py?.slice(0, 3)).toEqual([1234, 0, 100]);
    expect(store.getRow(accountRowKey(ID.rev1)).pyFy).toBe(1334);
    expect(store.getTotal('turnover').pyFy).toBe(1334);
    store.setView({ kind: 'cc1', memberId: ID.m1 });
    expect(store.getRow(accountRowKey(ID.rev1)).py).toBeNull(); // company-grain PY does not answer a CC1 view
    store.setPrior({ fiscalYear: 2027, grain: 'cc1', months: MONTHS, priorMonths: MONTHS, cells: [
      { glAccountId: ID.rev1, dimensionId: ID.m1, month: MONTHS[0]!, amount: 5 },
      { glAccountId: ID.rev1, dimensionId: ID.m2, month: MONTHS[0]!, amount: 7 },
    ] });
    expect(store.getRow(accountRowKey(ID.rev1)).py?.[0]).toBe(500);
  });

  it('a rebased reset keeps my values over fresh ones, dirty against fresh, with conflicts flagged', () => {
    const fresh = gridModel({ cells: [{ glAccountId: ID.rev1, cc1Id: null, cc2Id: null, buId: null, month: MONTHS[0]!, amount: 2000 }] });
    const values = new Map([[key(ID.rev1, 0), 5], [key(ID.rev2, 0), 6]]);
    store.reset(fresh, { view: COMPANY, canWrite: true, values, conflicts: [key(ID.rev1, 0)] });
    expect(store.getRow(accountRowKey(ID.rev1)).values[0]).toBe(5);
    expect(store.getRow(accountRowKey(ID.rev1)).conflict[0]).toBe(true);
    expect(store.getMeta()).toMatchObject({ dirtyCount: 2, conflicts: [key(ID.rev1, 0)] });
  });
});

describe('revision, amounts and live totals', () => {
  it('the revision moves on every value change (write, undo, reset), not on focus moves', () => {
    const spy = vi.fn();
    store.subscribeRevision(spy);
    const r0 = store.getRevision();
    store.apply([{ key: key(ID.rev2, 0), cents: 1 }]);
    expect(store.getRevision()).toBeGreaterThan(r0);
    const r1 = store.getRevision();
    store.apply([{ key: key(ID.rev2, 0), cents: 2 }]); // already dirty: dirtyCount stays 1, revision still moves
    expect(store.getRevision()).toBeGreaterThan(r1);
    const r2 = store.getRevision();
    store.setGridState({ ...store.getGridState(), focus: { r: 2, c: 1 }, anchor: { r: 2, c: 1 } });
    expect(store.getRevision()).toBe(r2);
    store.undo();
    expect(store.getRevision()).toBeGreaterThan(r2);
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('hasAmounts follows the live values; fyTotals are the live FY totals in rand', () => {
    expect(store.hasAmounts()).toBe(true);
    expect(store.fyTotals().turnover).toBe(1000);
    store.apply([{ key: key(ID.rev1, 0), cents: 12345 }]);
    expect(store.fyTotals().turnover).toBe(123.45);
    store.reset(gridModel({ cells: [] }), { view: COMPANY, canWrite: true });
    expect(store.hasAmounts()).toBe(false);
    store.apply([{ key: key(ID.rev2, 0), cents: 0 }]);
    expect(store.hasAmounts()).toBe(true);
  });
});
