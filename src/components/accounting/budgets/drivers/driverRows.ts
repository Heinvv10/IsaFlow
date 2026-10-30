/**
 * Rows and labels for the driver editor (P4 spec §7), from the grid's read model and the cells it
 * holds now. Pure.
 *
 * - The driven row is the account at the VIEW's grain (Company view: the company row; a dimension
 *   view: that member's row), as a grid edit lands (`viewCellKey`).
 * - The lines a pct_of_line driver may read: active, non-header income-statement accounts of the
 *   version, each at the grain it is budgeted at (a dimension-grain account offers one line per
 *   member holding amounts; an account with none offers its company row), never the row itself.
 */
import type { GridAccount, GridDimensions } from '@/modules/accounting/services/budgets/gridReadTypes';
import { type CellKey, parseKey, rowKeyOf } from '@/modules/accounting/services/budgets/grid/cellKey';
import { type View, viewCellKey } from '@/modules/accounting/services/budgets/grid/pivot';
import type { DriverGrain } from '@/modules/accounting/services/budgets/drivers/driverLine';
import type { RowKey } from '@/modules/accounting/services/budgets/drivers/driverTypes';
import type { RowOption, ScopeOption } from './DriverKindFields';

export interface RowLabels {
  account(id: string): string;
  accountName(id: string): string;
  member(id: string): string;
  /** "5000 Cost of sales (CC-A Alpha)" for a row key. */
  row(key: RowKey): string;
  /** The headcount scope: "the whole company" or a cost centre. */
  scope(id: string | null): string;
}

export function rowLabels(accounts: readonly GridAccount[], dimensions: GridDimensions): RowLabels {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const members = new Map([...dimensions.cc1, ...dimensions.cc2, ...dimensions.bu].map((m) => [m.id, `${m.code} ${m.name}`]));
  const account = (id: string) => { const a = byId.get(id); return a ? `${a.code} ${a.name}` : id; };
  const member = (id: string) => members.get(id) ?? id;
  return {
    account,
    accountName: (id) => byId.get(id)?.name ?? id,
    member,
    row: (key) => {
      const g = parseKey(`${key}|2000-01`);
      const m = g.cc1Id ?? g.cc2Id ?? g.buId;
      return m ? `${account(g.glAccountId)} (${member(m)})` : account(g.glAccountId);
    },
    scope: (id) => (id === null ? 'the whole company' : member(id)),
  };
}

/** The row a grid edit of `accountId` lands on in `view`. */
export function grainInView(accountId: string, view: View): DriverGrain {
  const { glAccountId, cc1Id, cc2Id, buId } = parseKey(viewCellKey(accountId, view, '2000-01'));
  return { glAccountId, cc1Id, cc2Id, buId };
}

/** The lines a pct_of_line driver on `driven` may read, in account order. */
export function refRowOptions(
  accounts: readonly GridAccount[], values: ReadonlyMap<CellKey, number | null>, driven: RowKey, labels: RowLabels,
): RowOption[] {
  const held = new Map<string, Set<RowKey>>();
  for (const [k, v] of values) {
    if (v === null) continue;
    const key = rowKeyOf(k);
    const acct = key.slice(0, key.indexOf('|'));
    const set = held.get(acct) ?? new Set<RowKey>();
    set.add(key);
    held.set(acct, set);
  }
  const out: RowOption[] = [];
  for (const a of accounts) {
    if (a.isHeader || !a.isActive) continue;
    const keys = held.get(a.id);
    const rows = keys && keys.size > 0 ? [...keys].sort() : [`${a.id}|||`];
    for (const key of rows) if (key !== driven) out.push({ key, label: labels.row(key) });
  }
  return out;
}

/** Every cost centre (CC1 and CC2) as a headcount scope. */
export function costCentreOptions(dimensions: GridDimensions): ScopeOption[] {
  return [...dimensions.cc1, ...dimensions.cc2].map((m) => ({ id: m.id, label: `${m.code} ${m.name}` }));
}
