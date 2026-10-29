/**
 * computeVersion (P4 spec §4): recompute every driver row of one version, in
 * dependency order, in integer cents. Pure: everything is passed in.
 *
 * - A driver computes each month in [fromMonth, toMonth] and nothing outside it.
 * - It never writes a closed month, nor a cell whose source is 'override' or 'actual'.
 * - Rows read the EFFECTIVE value of the rows they reference (after those rows'
 *   own computation, whatever the source). A referenced row with no cell in a
 *   month reads 0 and warns once per referenced row.
 * - Each value is rounded ONCE, half away from zero, from the exact ratio
 *   straight to the rounding unit (the driver's own, else the caller's;
 *   decision 5; no residue: drivers have no total). Never cents-then-unit.
 * - A 'driver' cell with no driver covering it (driver removed, range shrunk)
 *   is re-sourced 'manual', value kept. An 'override' is never touched.
 * - `writes` holds only cells whose amount or source differ from the input: per
 *   row in topo order, its driver writes in month order, then its re-sourced
 *   cells in month order. An unchanged recompute returns [].
 */
import {
  MAX_CENTS, ROUNDING_UNITS, divRoundHalfAway, isCents, type RoundingUnit,
} from '@/modules/accounting/services/budgets/grid/cents';
import { buildDriverGraph, topoOrder, type DriverGraph } from './driverGraph';
import {
  DriverRangeError, DriverRefError,
  type Cell, type DriverDef, type DriverRow, type DriverWarning, type DriverWarningCode,
  type HeadcountFn, type RowKey,
} from './driverTypes';

export interface ComputeInput {
  /** The version's months in order ('YYYY-MM'; 12, or 14 in a transition year). */
  months: readonly string[];
  rows: readonly DriverRow[];
  cells: ReadonlyMap<RowKey, readonly Cell[]>;
  /**
   * EVERY driver line of the version, never a subset: a row without a driver here has its
   * 'driver' cells re-sourced 'manual', so passing only the dependents would strip the others.
   */
  drivers: readonly DriverDef[];
  headcount: HeadcountFn;
  closedMonths: ReadonlySet<string>;
  rounding: RoundingUnit;
}

export interface DriverWrite {
  rowKey: RowKey;
  month: string;
  amount: number;
  /** 'driver': computed; 'manual': a stale driver/override cell re-sourced, value kept. */
  source: 'driver' | 'manual';
}

export interface ComputeResult {
  writes: DriverWrite[];
  warnings: DriverWarning[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const PCT_SCALE = 10_000n; // percent to 4 dp
const RATE_DEN = 100n * PCT_SCALE; // pct / 100 as an integer ratio
/** NUMERIC(9,4): the largest percent a driver line stores. */
export const MAX_PCT = 99999.9999;

/** Month → position. Refuses a malformed, repeated or out-of-order list. */
export function monthIndex(months: readonly string[]): Map<string, number> {
  const index = new Map<string, number>();
  months.forEach((m, i) => {
    if (!MONTH.test(m)) throw new DriverRefError(`Bad month: ${JSON.stringify(m)}`);
    if (i > 0 && (months[i - 1] as string) >= m) throw new DriverRefError(`Months are not ascending at ${m}`);
    index.set(m, i);
  });
  return index;
}

function scaledPct(pct: number, rowKey: RowKey): bigint {
  const scaled = pct * Number(PCT_SCALE);
  const whole = Math.round(scaled);
  if (!Number.isFinite(scaled) || Math.abs(scaled - whole) > 1e-4 || Math.abs(pct) > MAX_PCT) {
    throw new DriverRefError(`Row ${rowKey}: percent ${pct} is not a number within ±${MAX_PCT} with at most 4 decimals`, rowKey);
  }
  return BigInt(whole);
}

/** Save-time check of one driver against the version's months (and its own amounts / percent). */
export function assertDriverMonths(index: ReadonlyMap<string, number>, d: DriverDef): void {
  const from = index.get(d.fromMonth);
  const to = index.get(d.toMonth);
  if (from === undefined || to === undefined) {
    throw new DriverRefError(`Row ${d.rowKey}: range ${d.fromMonth}..${d.toMonth} is outside the version`, d.rowKey);
  }
  if (from > to) throw new DriverRefError(`Row ${d.rowKey}: from ${d.fromMonth} is after to ${d.toMonth}`, d.rowKey);
  if (d.kind === 'growth') {
    const base = index.get(d.baseMonth);
    if (base === undefined || base >= from) {
      throw new DriverRefError(`Row ${d.rowKey}: growth base ${d.baseMonth} must be a version month before ${d.fromMonth}`, d.rowKey);
    }
  }
  if (d.rounding !== undefined && !ROUNDING_UNITS.includes(d.rounding)) {
    throw new DriverRefError(`Row ${d.rowKey}: unknown rounding unit ${String(d.rounding)}`, d.rowKey);
  }
  if (d.kind === 'fixed' || d.kind === 'per_head') {
    if (!isCents(d.amount)) throw new DriverRangeError(`Row ${d.rowKey}: amount ${d.amount} is not whole cents in range`, d.rowKey);
  } else {
    scaledPct(d.pct, d.rowKey);
    if (d.kind === 'growth' && d.pct < -100) throw new DriverRefError(`Row ${d.rowKey}: growth ${d.pct}% is below -100%`, d.rowKey);
  }
}

function loadCells(cells: ComputeInput['cells'], graph: DriverGraph, index: ReadonlyMap<string, number>): Map<RowKey, Map<string, Cell>> {
  const out = new Map<RowKey, Map<string, Cell>>();
  for (const key of graph.nodes) out.set(key, new Map());
  for (const [key, list] of cells) {
    const byMonth = out.get(key);
    if (!byMonth) throw new DriverRefError(`Cells for unknown row ${key}`, key);
    for (const cell of list) {
      if (!index.has(cell.month)) throw new DriverRefError(`Row ${key}: cell month ${cell.month} is outside the version`, key);
      if (byMonth.has(cell.month)) throw new DriverRefError(`Row ${key}: two cells for ${cell.month}`, key);
      if (!isCents(cell.amount)) throw new DriverRangeError(`Row ${key}: ${cell.amount} is not whole cents in range`, key, cell.month);
      byMonth.set(cell.month, cell);
    }
  }
  return out;
}

/** Exact num/den cents → ONE half-away rounding to the unit (as grid/spread uplift), within NUMERIC(15,2). */
function toAmount(num: bigint, den: bigint, unit: RoundingUnit, rowKey: RowKey, month: string): number {
  if (!ROUNDING_UNITS.includes(unit)) throw new DriverRefError(`Row ${rowKey}: unknown rounding unit ${String(unit)}`, rowKey);
  const step = BigInt(unit * 100);
  const cents = divRoundHalfAway(num, den * step) * step;
  const limit = BigInt(MAX_CENTS);
  if (cents > limit || cents < -limit) throw new DriverRangeError(`Row ${rowKey} ${month}: result beyond the budget range`, rowKey, month);
  const out = Number(cents);
  return out === 0 ? 0 : out;
}

interface RowRun {
  read: (key: RowKey, month: string) => number | null;
  /** Records a month whose input was missing, under a warning code and the row it was read from. */
  miss: (code: DriverWarningCode, ref: RowKey, month: string) => void;
}

/** The exact value of driver `d` in month `i` as num / den cents. */
function ratio(d: DriverDef, i: number, input: ComputeInput, graph: DriverGraph, index: ReadonlyMap<string, number>, run: RowRun): [bigint, bigint] {
  const month = input.months[i] as string;
  switch (d.kind) {
    case 'fixed':
      return [BigInt(d.amount), 1n];
    case 'pct_of_line': {
      const ref = run.read(d.refRowKey, month);
      if (ref === null) run.miss('REF_MISSING', d.refRowKey, month);
      return [BigInt(ref ?? 0) * scaledPct(d.pct, d.rowKey), RATE_DEN];
    }
    case 'pct_of_section': {
      let sum = 0n;
      let any = false;
      for (const ref of graph.refs.get(d.rowKey) ?? []) {
        const v = run.read(ref, month);
        if (v !== null) { sum += BigInt(v); any = true; }
      }
      if (!any) run.miss('SECTION_EMPTY', d.section, month);
      return [sum * scaledPct(d.pct, d.rowKey), RATE_DEN];
    }
    case 'growth': {
      const k = BigInt(i - (index.get(d.baseMonth) as number));
      const base = run.read(d.rowKey, d.baseMonth);
      if (base === null) run.miss('BASE_MISSING', d.baseMonth, month);
      return [BigInt(base ?? 0) * (RATE_DEN + scaledPct(d.pct, d.rowKey)) ** k, RATE_DEN ** k];
    }
    case 'per_head': {
      const heads = input.headcount(d.headcountScope, month);
      if (!Number.isFinite(heads) || heads < 0) {
        throw new DriverRangeError(`Row ${d.rowKey} ${month}: headcount ${heads} is not a count`, d.rowKey, month);
      }
      return [BigInt(d.amount) * BigInt(Math.round(heads * 100)), 100n];
    }
  }
}

function warningText(code: DriverWarningCode, ref: string, months: readonly string[]): string {
  const when = months.join(', ');
  if (code === 'REF_MISSING') return `Referenced row ${ref} has no amount in ${when}; read as 0`;
  if (code === 'SECTION_EMPTY') return `Section ${ref} has no amount at this scope in ${when}; read as 0`;
  return `Growth base month ${ref} has no amount; ${when} read as 0`;
}

/**
 * Re-sources to 'manual' (value kept) every 'driver' cell no driver covers; closed months untouched.
 * An 'override' is left as it is: only "Reset to driver" (or deleting the driver, a service act)
 * ends one, so shrinking a range and growing it back never resets a typed value (spec §1.2).
 */
function resource(key: RowKey, own: Map<string, Cell>, covered: (month: string) => boolean, input: ComputeInput, writes: DriverWrite[]): void {
  for (const month of input.months) {
    const cell = own.get(month);
    if (!cell || cell.source !== 'driver' || covered(month) || input.closedMonths.has(month)) continue;
    own.set(cell.month, { ...cell, source: 'manual' });
    writes.push({ rowKey: key, month: cell.month, amount: cell.amount, source: 'manual' });
  }
}

export function computeVersion(input: ComputeInput): ComputeResult {
  const index = monthIndex(input.months);
  const graph = buildDriverGraph(input.rows, input.drivers);
  for (const d of input.drivers) assertDriverMonths(index, d);
  const order = topoOrder(graph);
  const effective = loadCells(input.cells, graph, index);
  const writes: DriverWrite[] = [];
  const warnings: DriverWarning[] = [];

  for (const key of order) {
    const d = graph.driverOf.get(key);
    const own = effective.get(key);
    if (!own) continue;
    if (!d) {
      resource(key, own, () => false, input, writes);
      continue;
    }
    const missing = new Map<string, { code: DriverWarningCode; ref: string; months: string[] }>();
    const run: RowRun = {
      read: (ref, month) => effective.get(ref)?.get(month)?.amount ?? null,
      miss: (code, ref, month) => {
        const id = `${code}|${ref}`;
        const entry = missing.get(id) ?? { code, ref, months: [] };
        entry.months.push(month);
        missing.set(id, entry);
      },
    };
    const from = index.get(d.fromMonth) as number;
    const to = index.get(d.toMonth) as number;
    for (let i = from; i <= to; i++) {
      const month = input.months[i] as string;
      if (input.closedMonths.has(month)) continue;
      const before = own.get(month);
      if (before && (before.source === 'override' || before.source === 'actual')) continue;
      const [num, den] = ratio(d, i, input, graph, index, run);
      const amount = toAmount(num, den, d.rounding ?? input.rounding, key, month);
      own.set(month, { month, amount, source: 'driver' });
      if (!before || before.amount !== amount || before.source !== 'driver') writes.push({ rowKey: key, month, amount, source: 'driver' });
    }
    resource(key, own, m => (index.get(m) as number) >= from && (index.get(m) as number) <= to, input, writes);
    for (const m of missing.values()) warnings.push({ code: m.code, rowKey: key, message: warningText(m.code, m.ref, m.months) });
  }
  return { writes, warnings };
}
