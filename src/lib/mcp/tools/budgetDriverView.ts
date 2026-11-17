/**
 * How the MCP driver tools (get_budget_drivers, set_budget_drivers; budget tools PR 3) show a version's drivers:
 * accounts and members by code (ids alongside), money as decimal text, months YYYY-MM. A per_head line a reader
 * receives without its rate (perHeadAccess, decision 15 / #979) is shown `per_head_restricted: true` and no amount.
 * Also the cell diff a driver write answers: every cell whose value or source the services changed, with its
 * status against the before-state (the recomputed dependents of other accounts included).
 */
import { parseKey, type CellKey } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { StoredDriverLine } from '@/modules/accounting/services/budgets/drivers/driverLine';
import type { StoredPlannedHire } from '@/modules/accounting/services/budgets/drivers/driverRepository';
import { isRestrictedPerHead, type VisibleDriverLine } from '@/modules/accounting/services/budgets/drivers/perHeadAccess';
import type { SnapshotCell } from '@/modules/accounting/services/budgets/budgetWriteSnapshots';
import type { CurrentCell } from '@/modules/accounting/services/budgets/cellWritePlan';
import { centsText, randText } from './budgetToolArgs';
import type { CellMap, DiffPage } from './budgetDiffView';
import type { BudgetLabels as DriverLabels } from './budgetLabels';

export function driverLineView(line: VisibleDriverLine | StoredDriverLine, l: DriverLabels) {
  return {
    id: line.id, account: l.account(line.glAccountId), account_id: line.glAccountId, ...l.grain(line), kind: line.kind,
    from_month: line.fromMonth, to_month: line.toMonth,
    ...(isRestrictedPerHead(line) ? { per_head_restricted: true } : { amount: line.amount === null ? null : randText(line.amount) }),
    pct: line.pct, ref: line.ref ? { account: l.account(line.ref.glAccountId), account_id: line.ref.glAccountId, ...l.grain(line.ref) } : null,
    section: line.section, scope: line.scope, base_month: line.baseMonth,
    ...(line.kind === 'per_head' ? { headcount_cost_centre: l.centre(line.headcountCostCentreId) } : {}),
    rounding_unit: line.rounding,
  };
}

export function hireView(h: StoredPlannedHire, l: DriverLabels) {
  return { id: h.id, label: h.label, cost_centre: l.centre(h.costCentreId), start_month: h.startMonth, end_month: h.endMonth, fte: h.fte };
}

export type DriverCellStatus = 'added' | 'changed' | 'removed';
export interface DriverCellChange { key: CellKey; status: DriverCellStatus; before?: CurrentCell; after?: CurrentCell }

const same = (a: CurrentCell, b: CurrentCell) => a.cents === b.cents && a.source === b.source;

/** Every cell whose value or source differs between the two reads, in key order. */
export function driverCellChanges(before: CellMap, after: CellMap): DriverCellChange[] {
  const out: DriverCellChange[] = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const b = before.get(key);
    const a = after.get(key);
    if (b && a && same(b, a)) continue;
    out.push({ key, status: b === undefined ? 'added' : a === undefined ? 'removed' : 'changed', before: b, after: a });
  }
  return out;
}

/** The snapshot of a driver write: every changed cell, before and after, with its source (budgetWriteSnapshots). */
export function driverSnapshotCells(changes: readonly DriverCellChange[]): SnapshotCell[] {
  const money = (c: CurrentCell | undefined) => (c === undefined ? null : centsText(c.cents));
  return changes.map((d) => {
    const r = parseKey(d.key);
    return { a: r.glAccountId, c1: r.cc1Id, c2: r.cc2Id, b: r.buId, m: r.month, before: money(d.before), after: money(d.after), bs: d.before?.source ?? null, as: d.after?.source ?? null };
  });
}

/** Counts per status and one page of the changed cells (accounts and members by code). */
export function driverCellListing(changes: readonly DriverCellChange[], l: DriverLabels, page: DiffPage) {
  const counts: Record<DriverCellStatus, number> = { added: 0, changed: 0, removed: 0 };
  for (const c of changes) counts[c.status] += 1;
  const cells = changes.slice(page.offset, page.offset + page.limit).map((c) => {
    const r = parseKey(c.key);
    return {
      account: l.account(r.glAccountId), ...l.grain(r), month: r.month, status: c.status,
      before: c.before ? centsText(c.before.cents) : null, after: c.after ? centsText(c.after.cents) : null,
      ...(c.before && c.before.source !== 'manual' ? { source_before: c.before.source } : {}),
      ...(c.after ? { source: c.after.source } : {}),
    };
  });
  const next = page.offset + cells.length;
  return { counts, cells, listed_total: changes.length, next_offset: next < changes.length ? next : null };
}
