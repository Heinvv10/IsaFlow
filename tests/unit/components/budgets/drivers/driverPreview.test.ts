/**
 * The browser-side driver pieces (P4 spec §7): the override's "driver value" from the pure engine
 * (a per_head figure without the headcount read is unknown, never a made-up 0), and the grid
 * store refusing what the server refuses: typing, pasting or clearing a closed month's actual,
 * and clearing a driver-computed cell (a clear of an override is "reset to driver", allowed).
 */
import { describe, expect, it } from 'vitest';
import { driverValueOf, type DriverContext } from '@/components/accounting/budgets/drivers/driverPreview';
import { GridStore } from '@/components/accounting/budgets/workspace/gridStore';
import { clearCells, DRIVER_CLEAR_REASON } from '@/components/accounting/budgets/workspace/gridCommands';
import { buildLayout } from '@/components/accounting/budgets/workspace/gridLayout';
import { cellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import { ID, MONTHS, driverLine, driverModel } from './driverFixture';

const k = (glAccountId: string, month: string) => cellKey({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month });

function storeOf(withActuals = false) {
  const store = new GridStore();
  store.reset(driverModel({ withActuals }), { view: { kind: 'company' }, canWrite: true });
  return store;
}
const ctx = (store: GridStore): DriverContext => ({ ...store.driverInputs(), months: MONTHS, closedMonths: store.getClosedMonths(), rounding: 1 });

describe('driverValueOf', () => {
  it("the override's driver value is the driver's figure from the row it reads", () => {
    const store = storeOf();
    expect(driverValueOf(ctx(store), `${ID.cos1}|||`, MONTHS[2]!, () => undefined)).toBe(38_000);
  });

  it('per_head: unknown until the headcount is read, then amount × heads', () => {
    const store = storeOf();
    const c = { ...ctx(store), drivers: [driverLine({ glAccountId: ID.opex, kind: 'per_head', amount: 32_000 })] };
    expect(driverValueOf(c, `${ID.opex}|||`, MONTHS[4]!, () => undefined)).toBeNull();
    const heads = new Map(MONTHS.map((m) => [m, 2.5]));
    expect(driverValueOf(c, `${ID.opex}|||`, MONTHS[4]!, (scope) => (scope === null ? heads : undefined))).toBe(8_000_000);
  });

  it('a closed month has no driver value', () => {
    const store = storeOf(true);
    expect(driverValueOf(ctx(store), `${ID.cos1}|||`, MONTHS[0]!, () => undefined)).toBeNull();
  });
});

describe('the grid store and P4 sources', () => {
  const r = (id: string) => buildLayout(driverModel().accounts, MONTHS).rows.find((x) => x.key === `acct:${id}`)!.index;

  it("a closed month's cell takes no write and is not editable", () => {
    const store = storeOf(true);
    expect(store.isEditable({ r: r(ID.rev1), c: 0 })).toBe(false);
    expect(store.isEditable({ r: r(ID.rev1), c: 2 })).toBe(true);
    expect(store.isEditable({ r: r(ID.rev1), c: MONTHS.length })).toBe(false);
    expect(store.apply([{ key: k(ID.rev1, MONTHS[0]!), cents: 1 }, { key: k(ID.rev1, MONTHS[2]!), cents: 1 }])).toBe(1);
    expect(store.valueAt(k(ID.rev1, MONTHS[0]!))).toBe(100_000);
  });

  it('clearing a driver cell is dropped with the reason; clearing an override is taken', () => {
    const store = storeOf();
    clearCells(store, [{ r: r(ID.cos1), c: 1 }]);
    expect(store.valueAt(k(ID.cos1, MONTHS[1]!))).toBe(38_000);
    expect(store.getMeta().announcement.text).toBe(DRIVER_CLEAR_REASON);
    clearCells(store, [{ r: r(ID.cos1), c: 2 }]);
    expect(store.valueAt(k(ID.cos1, MONTHS[2]!))).toBeNull();
  });

  it('row snapshots carry the sources and the driver at the view grain', () => {
    const store = storeOf();
    const snap = store.getRow(`acct:${ID.cos1}`);
    expect(snap.sources.slice(0, 3)).toEqual(['driver', 'driver', 'override']);
    expect(snap.driver?.kind).toBe('pct_of_line');
    expect(store.getRow(`acct:${ID.rev2}`).driver).toBeNull();
  });
});
