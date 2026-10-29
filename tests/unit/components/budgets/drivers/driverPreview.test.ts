/**
 * The browser-side driver pieces (P4 spec §7): the override's "driver value" from the pure engine
 * (a per_head figure without the headcount read is unknown, never a made-up 0), and the grid
 * store refusing what the server refuses: typing, pasting or clearing a closed month's actual,
 * and clearing a driver-computed cell (a clear of an override is "reset to driver", allowed).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { driverValueOf, previewDriver, previewRefusal, type DriverContext } from '@/components/accounting/budgets/drivers/driverPreview';
import { log } from '@/lib/logger';
import { DriverRangeError, DriverRefError } from '@/modules/accounting/services/budgets/drivers/driverTypes';
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

  it("another row's per_head driver never blanks this row's value: it is read as it stands (no headcount needed)", () => {
    const store = storeOf();
    const perHead = driverLine({ glAccountId: ID.opex, kind: 'per_head', amount: 32_000 });
    const c = { ...ctx(store), drivers: [...ctx(store).drivers.filter((d) => d.glAccountId !== ID.opex), perHead] };
    expect(driverValueOf(c, `${ID.cos1}|||`, MONTHS[2]!, () => undefined)).toBe(38_000);
    const p = previewDriver(c, { ...c.drivers[0]!, pct: 40 }, () => undefined);
    expect(p.ok && p.headcountMissing).toBe(false);
    expect(p.ok && p.values[1]).toBe(40_000);
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

  it('clearing a driver cell typed over since (unsaved) goes back to the driver value, not dropped', () => {
    const store = storeOf();
    const key = k(ID.cos1, MONTHS[1]!);
    store.apply([{ key, cents: 12_345 }]);
    expect(store.getMeta().dirtyCount).toBe(1);
    clearCells(store, [{ r: r(ID.cos1), c: 1 }]);
    expect(store.valueAt(key)).toBe(38_000);
    expect(store.getMeta().dirtyCount).toBe(0);
  });

  it('row snapshots carry the sources and the driver at the view grain', () => {
    const store = storeOf();
    const snap = store.getRow(`acct:${ID.cos1}`);
    expect(snap.sources.slice(0, 3)).toEqual(['driver', 'driver', 'override']);
    expect(snap.driver?.kind).toBe('pct_of_line');
    expect(store.getRow(`acct:${ID.rev2}`).driver).toBeNull();
  });
});

describe('previewRefusal', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it("names the engine's refusals in plain words, without row keys, and logs nothing", () => {
    const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const key = `${ID.cos1}|||`;
    expect(previewRefusal(new DriverRangeError(`Row ${key}: result beyond the budget range`, key)))
      .toBe('An amount this driver computes is beyond the budget range: use a smaller amount or percentage.');
    expect(previewRefusal(new DriverRefError(`Row ${key}: range 2026-01..2026-02 is outside the version`, key)))
      .toBe('This driver cannot compute with these months, line or base month: check them, or Save to see what the server says.');
    expect(logged).not.toHaveBeenCalled();
  });

  it('an unexpected error keeps the generic sentence on screen and is logged with the error', () => {
    const logged = vi.spyOn(log, 'error').mockImplementation(() => undefined);
    const boom = new TypeError('cannot read properties of undefined');
    expect(previewRefusal(boom)).toBe('The preview could not be computed for this driver.');
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged).toHaveBeenCalledWith('Driver preview failed unexpectedly', { error: boom }, 'budget-drivers');
  });
});
