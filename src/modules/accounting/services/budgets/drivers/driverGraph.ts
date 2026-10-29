/**
 * The driver dependency graph (P4 spec §4). Edges run driven row ← the rows it
 * reads: pct_of_line reads its ref row; pct_of_section reads every row of that
 * band at the scope (a row inside its own section is a self-edge, so a cycle).
 * growth reads its own base month (intra-row, no edge); fixed and per_head read
 * no row. `topoOrder` is Kahn's algorithm, ties broken by row key.
 */
import { grainOf } from '@/modules/accounting/services/budgets/grid/cellKey';
import {
  DriverCycleError, DriverRefError, rowKeyFor,
  type DriverDef, type DriverRow, type PctOfSectionDriver, type RowKey,
} from './driverTypes';

export interface DriverGraph {
  /** Every row key, sorted. */
  nodes: RowKey[];
  rows: ReadonlyMap<RowKey, DriverRow>;
  driverOf: ReadonlyMap<RowKey, DriverDef>;
  /** Driven row → the rows it reads. A section driver's refs are its section members. */
  refs: ReadonlyMap<RowKey, ReadonlySet<RowKey>>;
  /** Row → the driven rows that read it. */
  dependents: ReadonlyMap<RowKey, ReadonlySet<RowKey>>;
}

const sameGrain = (a: DriverRow, b: DriverRow): boolean =>
  a.cc1Id === b.cc1Id && a.cc2Id === b.cc2Id && a.buId === b.buId;

function checkRow(row: DriverRow): void {
  let expected: RowKey;
  try {
    expected = rowKeyFor(row);
  } catch (e) {
    throw new DriverRefError(`Bad row ${JSON.stringify(row.key)}: ${e instanceof Error ? e.message : String(e)}`, row.key);
  }
  if (expected !== row.key) throw new DriverRefError(`Row key ${JSON.stringify(row.key)} does not match its ids (${expected})`, row.key);
  if (grainOf(row) === 'multi') throw new DriverRefError(`Row ${row.key} sets more than one dimension`, row.key);
}

function sectionMembers(rows: Iterable<DriverRow>, driven: DriverRow, d: PctOfSectionDriver): RowKey[] {
  const out: RowKey[] = [];
  for (const r of rows) {
    if (r.band === d.section && (d.scope === 'company' || sameGrain(r, driven))) out.push(r.key);
  }
  return out;
}

export function buildDriverGraph(rows: readonly DriverRow[], drivers: readonly DriverDef[]): DriverGraph {
  const byKey = new Map<RowKey, DriverRow>();
  for (const row of rows) {
    checkRow(row);
    if (byKey.has(row.key)) throw new DriverRefError(`Row ${row.key} is listed twice`, row.key);
    byKey.set(row.key, row);
  }
  const driverOf = new Map<RowKey, DriverDef>();
  const refs = new Map<RowKey, Set<RowKey>>();
  const dependents = new Map<RowKey, Set<RowKey>>();
  for (const key of byKey.keys()) { refs.set(key, new Set()); dependents.set(key, new Set()); }
  const edge = (driven: RowKey, ref: RowKey) => {
    refs.get(driven)?.add(ref);
    dependents.get(ref)?.add(driven);
  };

  for (const d of drivers) {
    const driven = byKey.get(d.rowKey);
    if (!driven) throw new DriverRefError(`Driver on unknown row ${d.rowKey}`, d.rowKey);
    if (driverOf.has(d.rowKey)) throw new DriverRefError(`Row ${d.rowKey} has more than one driver`, d.rowKey);
    driverOf.set(d.rowKey, d);
    if (d.kind === 'pct_of_line') {
      if (!byKey.has(d.refRowKey)) throw new DriverRefError(`Row ${d.rowKey} refers to unknown row ${d.refRowKey}`, d.rowKey);
      edge(d.rowKey, d.refRowKey);
    } else if (d.kind === 'pct_of_section') {
      for (const ref of sectionMembers(byKey.values(), driven, d)) edge(d.rowKey, ref);
    }
  }
  return { nodes: [...byKey.keys()].sort(), rows: byKey, driverOf, refs, dependents };
}

function insertSorted(xs: RowKey[], x: RowKey): void {
  let i = 0;
  while (i < xs.length && (xs[i] as RowKey) < x) i++;
  xs.splice(i, 0, x);
}

/** A cycle among the rows Kahn could not order, rotated to its smallest key, in data-flow order. */
function findCycle(graph: DriverGraph, ordered: ReadonlySet<RowKey>): RowKey[] {
  const remaining = graph.nodes.filter(n => !ordered.has(n));
  // Every unordered row still reads at least one unordered row, so walking
  // refs backwards from any of them must revisit a row: that loop is a cycle.
  const seenAt = new Map<RowKey, number>();
  const trail: RowKey[] = [];
  let cur = remaining[0] as RowKey;
  while (!seenAt.has(cur)) {
    seenAt.set(cur, trail.length);
    trail.push(cur);
    const next = [...(graph.refs.get(cur) ?? [])].filter(r => !ordered.has(r)).sort()[0];
    if (next === undefined) throw new Error(`Driver graph invariant broken at ${cur}`);
    cur = next;
  }
  const loop = trail.slice(seenAt.get(cur)).reverse();
  const start = loop.indexOf([...loop].sort()[0] as RowKey);
  const rotated = [...loop.slice(start), ...loop.slice(0, start)];
  return [...rotated, rotated[0] as RowKey];
}

/** Row keys with every row after the rows it reads. Throws DriverCycleError on a cycle. */
export function topoOrder(graph: DriverGraph): RowKey[] {
  const pending = new Map<RowKey, number>(graph.nodes.map(n => [n, graph.refs.get(n)?.size ?? 0]));
  const ready = graph.nodes.filter(n => pending.get(n) === 0);
  const order: RowKey[] = [];
  while (ready.length > 0) {
    const n = ready.shift() as RowKey;
    order.push(n);
    for (const d of graph.dependents.get(n) ?? []) {
      const left = (pending.get(d) ?? 0) - 1;
      pending.set(d, left);
      if (left === 0) insertSorted(ready, d);
    }
  }
  if (order.length < graph.nodes.length) throw new DriverCycleError(findCycle(graph, new Set(order)));
  return order;
}

/** Driver-save validator: refuses unknown refs and any cycle. */
export function assertNoCycle(rows: readonly DriverRow[], drivers: readonly DriverDef[]): void {
  topoOrder(buildDriverGraph(rows, drivers));
}
