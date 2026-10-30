/**
 * The engine's view of one version (P4 spec §4, §5), read for a recompute or a driver save's cycle
 * check. Rows = every revenue/expense account + grain holding cells in the version or named by a
 * driver (its own row or the row it reads), banded by account type and subtype (`bandOf`, the
 * grid's sections); cells with their `amount_source`; the months holding an 'actual' cell (a
 * reforecast's closed months, which no driver writes).
 *
 * A driver that cannot compute is SKIPPED, not fatal: its account, or the account it reads, is no
 * longer an income-statement account (retyped since), or its months no longer lie inside the
 * version. It is left out of the engine input with a labelled message, and the caller freezes its
 * row, so one stale driver never blocks every grid save of the version. A driver SAVE still
 * refuses such a driver (`checkDriverLine`, `assertDriverMonths`).
 */
import { sql, type DbRow } from '@/lib/neon';
import { monthKeyToDate } from '../../reports/budgetPeriodWindow';
import { toCents } from '../grid/cents';
import { bandOf } from '../grid/subtotals';
import { assertDriverMonths, monthIndex } from './driverEngine';
import { buildDriverGraph, topoOrder, type DriverGraph } from './driverGraph';
import {
  DriverCycleError, DriverRangeError, DriverRefError, rowKeyFor,
  type Cell, type CellSource, type DriverDef, type DriverRow, type RowKey,
} from './driverTypes';
import { rowKeyOfGrain, toDriverDef, type DriverGrain, type DriverLine } from './driverLine';

export interface SkippedDriver {
  rowKey: RowKey;
  /** "driver on 5100 Cost of sales cannot compute: …; change or delete the driver" */
  message: string;
}

export interface VersionModel {
  months: string[];
  rows: DriverRow[];
  cells: Map<RowKey, Cell[]>;
  /** The drivers that can compute this pass. */
  defs: DriverDef[];
  /** Every stored driver (skipped ones included), for the save-time cycle check. */
  allDefs: DriverDef[];
  /** Grains a driver names that are not rows (not income-statement accounts). */
  unplaced: Array<DriverGrain & { key: RowKey }>;
  skipped: SkippedDriver[];
  /** Months in which the version holds an 'actual' cell. */
  closedMonths: Set<string>;
  /** Account id → "code name", for messages. */
  labels: Map<string, string>;
}

const id = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** "5100 Cost of sales (CC1)" for a row key. */
export function rowLabel(key: RowKey, labels: ReadonlyMap<string, string>): string {
  const [acct = '', cc1, cc2, bu] = key.split('|');
  const dim = cc1 ? ' (CC1)' : cc2 ? ' (CC2)' : bu ? ' (BU)' : '';
  return `${labels.get(acct) ?? acct}${dim}`;
}

const ROW_KEY = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\|[0-9a-f-]*\|[0-9a-f-]*\|[0-9a-f-]*/g;

/** The engine's messages name rows by key: name them by account instead. */
export const labelKeys = (text: string, labels: ReadonlyMap<string, string>): string =>
  text.replace(ROW_KEY, (key) => rowLabel(key, labels));

export async function loadVersionModel(
  companyId: string, versionId: string, months: string[], lines: readonly DriverLine[],
): Promise<VersionModel> {
  const cellRows = (await sql`
    SELECT gl_account_id::text AS a, cc1_id::text AS c1, cc2_id::text AS c2, bu_id::text AS b, to_char(month, 'YYYY-MM') AS m,
           amount::text AS amount, amount_source
      FROM budget_month_amounts
     WHERE company_id = ${companyId}::UUID AND version_id = ${versionId}::UUID
       AND month BETWEEN ${monthKeyToDate(months[0]!)}::DATE AND ${monthKeyToDate(months[months.length - 1]!)}::DATE
  `) as DbRow[];
  const grains = new Map<RowKey, DriverGrain>();
  const cellsOf = new Map<RowKey, Cell[]>();
  const closedMonths = new Set<string>();
  for (const r of cellRows) {
    const g = { glAccountId: String(r.a), cc1Id: id(r.c1), cc2Id: id(r.c2), buId: id(r.b) };
    const key = rowKeyFor(g);
    grains.set(key, g);
    const source = String(r.amount_source) as CellSource;
    if (source === 'actual') closedMonths.add(String(r.m));
    const list = cellsOf.get(key) ?? [];
    list.push({ month: String(r.m), amount: toCents(Number(r.amount)), source });
    cellsOf.set(key, list);
  }
  for (const line of lines) {
    grains.set(rowKeyOfGrain(line), line);
    if (line.ref) grains.set(rowKeyOfGrain(line.ref), line.ref);
  }

  const accountIds = [...new Set([...grains.values()].map((g) => g.glAccountId))];
  const accounts = (await sql`
    SELECT id::text AS id, account_code, account_name, account_type, account_subtype FROM gl_accounts
     WHERE company_id = ${companyId}::UUID AND id = ANY(${accountIds}::UUID[])
  `) as DbRow[];
  const byId = new Map(accounts.map((a) => [String(a.id), a]));
  const labels = new Map(accounts.map((a) => [String(a.id), `${String(a.account_code)} ${String(a.account_name ?? '')}`.trim()]));

  const rows: DriverRow[] = [];
  const cells = new Map<RowKey, Cell[]>();
  for (const [key, g] of grains) {
    const a = byId.get(g.glAccountId);
    // Not an income-statement account (retyped since): not a row; a driver naming it is skipped below.
    if (!a || (a.account_type !== 'revenue' && a.account_type !== 'expense')) continue;
    rows.push({ key, ...g, band: bandOf(a.account_type, a.account_subtype === null ? null : String(a.account_subtype)) });
    const own = cellsOf.get(key);
    if (own) cells.set(key, own);
  }

  const placed = new Set(rows.map((r) => r.key));
  const { defs, skipped } = placeDrivers(lines, placed, labels, months);
  const unplaced = [...grains].filter(([key]) => !placed.has(key)).map(([key, g]) => ({ key, ...g }));
  const allDefs = lines.flatMap((l) => {
    try {
      return [toDriverDef(l)];
    } catch (err) {
      // A line the engine cannot read is skipped by placeDrivers (with its reason); no edge to draw.
      if (err instanceof DriverRefError || err instanceof DriverRangeError) return [];
      throw err;
    }
  });
  return { months, rows, cells, defs, allDefs, unplaced, skipped, closedMonths, labels };
}

/**
 * Splits the version's drivers into those that compute and those skipped, with the reason. A
 * driver is skipped when its row or the row it reads is not `placed` (not an income-statement
 * account), or its months do not lie inside the version.
 */
export function placeDrivers(
  lines: readonly DriverLine[], placed: ReadonlySet<RowKey>, labels: ReadonlyMap<string, string>, months: readonly string[],
): { defs: DriverDef[]; skipped: SkippedDriver[] } {
  const index = monthIndex(months);
  const defs: DriverDef[] = [];
  const skipped: SkippedDriver[] = [];
  for (const line of lines) {
    const key = rowKeyOfGrain(line);
    let reason: string | null = null;
    let def: DriverDef | null = null;
    if (!placed.has(key)) reason = 'the account is no longer an income-statement account';
    else if (line.ref && !placed.has(rowKeyOfGrain(line.ref))) {
      reason = `the account it reads (${rowLabel(rowKeyOfGrain(line.ref), labels)}) is no longer an income-statement account`;
    } else {
      try {
        def = toDriverDef(line);
        assertDriverMonths(index, def);
      } catch (err) {
        if (!(err instanceof DriverRefError || err instanceof DriverRangeError)) throw err;
        reason = labelKeys(err.message, labels);
      }
    }
    if (reason !== null || def === null) {
      skipped.push({ rowKey: key, message: `driver on ${rowLabel(key, labels)} cannot compute: ${reason}; change or delete the driver` });
    } else {
      defs.push(def);
    }
  }
  return { defs, skipped };
}

/**
 * The graph of EVERY stored driver, skipped ones included, for the save-time cycle check: a loop
 * through a driver skipped today (its account retyped) comes back the day the account does. A row
 * that is not an income-statement account sits in no section, so section drivers read none of it.
 */
export function fullDriverGraph(model: VersionModel): DriverGraph {
  const placed = new Set(model.rows.map((r) => r.key));
  // Any band will do for a row no section driver may read: its section edges are dropped below.
  const rows: DriverRow[] = [...model.rows, ...model.unplaced.map((g) => ({ ...g, band: 'other_expense' as const }))];
  const graph = buildDriverGraph(rows, model.allDefs);
  const refs = new Map<RowKey, Set<RowKey>>();
  const dependents = new Map<RowKey, Set<RowKey>>(graph.nodes.map((n) => [n, new Set<RowKey>()]));
  for (const [key, read] of graph.refs) {
    const section = graph.driverOf.get(key)?.kind === 'pct_of_section';
    const kept = [...read].filter((r) => !section || placed.has(r));
    refs.set(key, new Set(kept));
    for (const r of kept) dependents.get(r)?.add(key);
  }
  return { ...graph, refs, dependents };
}

/**
 * The drivers that compute once stored loops are taken out. A loop can be stored behind the save
 * check (a skipped driver's account comes back, an account moves into a section a driver reads):
 * its drivers sit out the pass and their rows stay frozen, each loop named in a labelled message.
 * Each round removes at least one driver, so it ends. The recompute and the grid save's clear rules
 * both use this, so "skipped" means the same in both.
 */
export function breakLoops(model: VersionModel): { defs: DriverDef[]; loops: Array<{ path: RowKey[]; message: string }> } {
  let defs = model.defs;
  const loops: Array<{ path: RowKey[]; message: string }> = [];
  for (;;) {
    try {
      topoOrder(buildDriverGraph(model.rows, defs));
      return { defs, loops };
    } catch (err) {
      if (!(err instanceof DriverCycleError)) throw err;
      const onPath = new Set(err.path);
      defs = defs.filter((d) => !onPath.has(d.rowKey));
      const names = err.path.map((k) => rowLabel(k, model.labels)).join(' → ');
      loops.push({ path: err.path, message: `drivers on ${names} form a loop; change one of them` });
    }
  }
}

/** Every row a driver skipped this pass sits on: unplaced, out of its months, or in a stored loop. */
export function skippedRows(model: VersionModel): Set<RowKey> {
  return new Set([...model.skipped.map((x) => x.rowKey), ...breakLoops(model).loops.flatMap((l) => l.path)]);
}

/**
 * A loop through `key` in the graph, in data-flow order (first == last), or null. The save refuses
 * only a loop its own driver is part of: one stored elsewhere stays skipped with its warning.
 */
export function cycleThrough(graph: DriverGraph, key: RowKey): RowKey[] | null {
  // Depth-first along the rows each row reads; reaching `key` again closes a loop through it.
  const seen = new Set<RowKey>();
  const walk = (row: RowKey, trail: RowKey[]): RowKey[] | null => {
    for (const next of [...(graph.refs.get(row) ?? [])].sort()) {
      if (next === key) return [...trail, key];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...trail, next]);
      if (found) return found;
    }
    return null;
  };
  const reads = walk(key, [key]);
  // `reads` runs reader → read; data flows the other way.
  return reads ? reads.reverse() : null;
}
