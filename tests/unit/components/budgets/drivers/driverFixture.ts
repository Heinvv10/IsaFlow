/**
 * The workspace grid fixture with P4 drivers: Sales (1000) is typed R 1 000 every month; Cost of
 * sales (2000) is driven at 38% of Sales, with Mar typed over (an override, R 500); opex 3100 has
 * a fixed R 15 000 driver. `withActuals` makes the first two months a reforecast's closed months
 * (every row an 'actual' cell there). Amounts are rand, as on the wire.
 */
import type { GridCell, GridReadModel } from '@/modules/accounting/services/budgets/gridReadTypes';
import type { StoredDriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import { ID, MONTHS, TOKEN, gridModel } from '../workspace/gridFixture';

export { ID, MONTHS, TOKEN };
export const T2 = '2026-10-29T08:00:00.000002Z';
/** A 14-month transition year (Jan 2026 - Feb 2027), as after a change of year end. */
export const MONTHS14 = ['2026-01', '2026-02', ...MONTHS];
export const T3 = '2026-10-29T08:05:00.000003Z';

const NONE = { amount: null, pct: null, ref: null, section: null, scope: null, baseMonth: null, headcountCostCentreId: null } as const;
const grain = (glAccountId: string) => ({ glAccountId, cc1Id: null, cc2Id: null, buId: null });

export function driverLine(over: Partial<StoredDriverLine> & Pick<StoredDriverLine, 'glAccountId' | 'kind'>): StoredDriverLine {
  return {
    id: `d0000000-0000-4000-8000-${over.glAccountId.slice(-12)}`, updatedAt: TOKEN, cc1Id: null, cc2Id: null, buId: null,
    fromMonth: MONTHS[0]!, toMonth: MONTHS[11]!, rounding: 1, ...NONE, ...over,
  };
}

export const COGS_DRIVER = driverLine({ glAccountId: ID.cos1, kind: 'pct_of_line', pct: 38, ref: grain(ID.rev1) });
export const OPEX_DRIVER = driverLine({ glAccountId: ID.opex, kind: 'fixed', amount: 15000 });

const cell = (glAccountId: string, month: string, amount: number, source: GridCell['source']): GridCell =>
  ({ glAccountId, cc1Id: null, cc2Id: null, buId: null, month, amount, source });

/**
 * `withActuals`: the first `closed` months (default 2) are closed; `months`: the year's months
 * (MONTHS14 for a transition year). The drivers cover the whole year.
 */
export function driverModel(opts: { withActuals?: boolean; closed?: number; months?: readonly string[] } = {}): GridReadModel {
  const base = gridModel();
  const months = opts.months ?? MONTHS;
  const closed = new Set(opts.withActuals ? months.slice(0, opts.closed ?? 2) : []);
  const src = (m: string, s: GridCell['source']): GridCell['source'] => (closed.has(m) ? 'actual' : s);
  const cells: GridCell[] = [
    ...months.map((m) => cell(ID.rev1, m, 1000, src(m, 'manual'))),
    ...months.map((m, i) => cell(ID.cos1, m, i === 2 ? 500 : 380, src(m, i === 2 ? 'override' : 'driver'))),
    ...months.map((m) => cell(ID.opex, m, 15000, src(m, 'driver'))),
  ];
  const span = { fromMonth: months[0]!, toMonth: months[months.length - 1]! };
  return {
    ...base,
    version: base.version && { ...base.version, kind: opts.withActuals ? 'reforecast' : 'original' },
    accounts: base.accounts.map((a) => (a.id === ID.opex ? { ...a, grain: 'company' as const } : a)),
    year: { ...base.year, monthKeys: [...months], startDate: `${months[0]}-01`, kind: months.length === 12 ? 'normal' : 'transition' },
    cells, drivers: [{ ...COGS_DRIVER, ...span }, { ...OPEX_DRIVER, ...span }],
  };
}
