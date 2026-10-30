/**
 * The driver editor's live preview and the override mark's "driver value", computed in the
 * browser with P4's PURE engine (`computeVersion`: no I/O, no `sql`), over what the grid holds:
 * the version's cells with their sources, every driver line of the version, the closed months
 * and the headcount the panel read. The server recomputes on save; this only shows what it will.
 *
 * Rows are every account × grain the cells or drivers name (accounts the grid does not list are
 * left out, and a driver naming one is dropped from the pass, as the server skips it). Every
 * per_head row but the one asked about is read as it stands (`frozenRows`), as the server freezes
 * them outside a refresh; that row's headcount not read yet counts 0 and the preview says so
 * (`headcountMissing`).
 */
import { log } from '@/lib/logger';
import { computeVersion } from '@/modules/accounting/services/budgets/drivers/driverEngine';
import {
  normaliseLine, rowKeyOfGrain, toDriverDef, type DriverGrain, type DriverLineInput, type StoredDriverLine,
} from '@/modules/accounting/services/budgets/drivers/driverLine';
import {
  DriverCycleError, DriverRangeError, DriverRefError, type Cell, type CellSource, type DriverDef, type DriverRow, type HeadcountFn, type RowKey,
} from '@/modules/accounting/services/budgets/drivers/driverTypes';
import { type CellKey, parseKey, rowKeyOf } from '@/modules/accounting/services/budgets/grid/cellKey';
import type { RoundingUnit } from '@/modules/accounting/services/budgets/grid/cents';
import type { Band } from '@/modules/accounting/services/budgets/grid/subtotals';

export interface DriverContext {
  /** The version's months ('YYYY-MM'; 12, or 14 in a transition year). */
  months: readonly string[];
  /** Listed income-statement accounts → their band. */
  bands: ReadonlyMap<string, Band>;
  /** Cents by cell key; null = cleared. */
  values: ReadonlyMap<CellKey, number | null>;
  sources: ReadonlyMap<CellKey, CellSource>;
  drivers: readonly StoredDriverLine[];
  closedMonths: ReadonlySet<string>;
  rounding: RoundingUnit;
}

/** FTE per month for a scope (cost centre id or null = company); undefined when not read yet. */
export type HeadcountLookup = (scope: string | null) => ReadonlyMap<string, number> | undefined;

export type PreviewResult =
  | {
    ok: true;
    /** Cents per version month, after the drivers ran; null = no amount. */
    values: (number | null)[];
    sources: (CellSource | null)[];
    /** The engine's warnings for this row (REF_MISSING, SECTION_EMPTY, BASE_MISSING). */
    warnings: string[];
    /** A per_head driver read a scope whose headcount has not been loaded: it counted 0. */
    headcountMissing: boolean;
  }
  | { ok: false; kind: 'cycle'; path: RowKey[] }
  | { ok: false; kind: 'invalid'; message: string };

const known = (ctx: DriverContext, g: DriverGrain | null): boolean => g === null || ctx.bands.has(g.glAccountId);

function rowOf(key: RowKey, band: Band): DriverRow {
  const ref = parseKey(`${key}|2000-01`);
  return { key, glAccountId: ref.glAccountId, cc1Id: ref.cc1Id, cc2Id: ref.cc2Id, buId: ref.buId, band };
}

interface Pass {
  rows: DriverRow[];
  cells: Map<RowKey, Cell[]>;
  defs: DriverDef[];
}

/** The engine input for `lines` (every driver of the version, one per row), over the grid's cells. */
function buildPass(ctx: DriverContext, lines: readonly (StoredDriverLine | ReturnType<typeof normaliseLine>)[], resource?: RowKey): Pass {
  const months = new Set(ctx.months);
  const byRow = new Map<RowKey, Map<string, Cell>>();
  const rowBand = new Map<RowKey, Band>();
  for (const [k, v] of ctx.values) {
    if (v === null) continue;
    const month = k.slice(k.lastIndexOf('|') + 1);
    const acct = k.slice(0, k.indexOf('|'));
    const band = ctx.bands.get(acct);
    if (!band || !months.has(month)) continue;
    const key = rowKeyOf(k);
    rowBand.set(key, band);
    const own = byRow.get(key) ?? new Map<string, Cell>();
    const source = ctx.sources.get(k) ?? 'manual';
    // "What would the driver say here?": that row's overrides count as driver cells for one pass.
    own.set(month, { month, amount: v, source: key === resource && source === 'override' ? 'driver' : source });
    byRow.set(key, own);
  }
  const defs: DriverDef[] = [];
  for (const line of lines) {
    if (!known(ctx, line) || !known(ctx, line.ref)) continue;
    const key = rowKeyOfGrain(line);
    rowBand.set(key, ctx.bands.get(line.glAccountId)!);
    if (line.ref) rowBand.set(rowKeyOfGrain(line.ref), ctx.bands.get(line.ref.glAccountId)!);
    defs.push(toDriverDef(line));
  }
  const rows = [...rowBand.entries()].map(([key, band]) => rowOf(key, band));
  const cells = new Map([...byRow.entries()].map(([key, own]) => [key, ctx.months.flatMap((m) => own.get(m) ?? [])] as const));
  return { rows, cells, defs };
}

/** The per_head rows except `key`: they keep their stored figures this pass (no headcount read). */
function otherHeadRows(pass: Pass, key: RowKey): Set<RowKey> {
  return new Set(pass.defs.filter((d) => d.kind === 'per_head' && d.rowKey !== key).map((d) => d.rowKey));
}

function headcountFn(lookup: HeadcountLookup, missing: { any: boolean }): HeadcountFn {
  return (scope, month) => {
    const counts = lookup(scope);
    if (!counts) { missing.any = true; return 0; }
    return counts.get(month) ?? 0;
  };
}

/** The row's effective values after a pass, in version month order. */
function rowAfter(ctx: DriverContext, pass: Pass, key: RowKey, writes: ReturnType<typeof computeVersion>['writes']) {
  const own = new Map((pass.cells.get(key) ?? []).map((c) => [c.month, c] as const));
  for (const w of writes) if (w.rowKey === key) own.set(w.month, { month: w.month, amount: w.amount, source: w.source });
  return {
    values: ctx.months.map((m) => own.get(m)?.amount ?? null),
    sources: ctx.months.map((m) => own.get(m)?.source ?? null),
  };
}

/**
 * A plain sentence for a preview the engine refused. The engine's own text names rows by key (`acct|cc1|cc2|bu`),
 * which means nothing on screen; the server's 400 on Save says exactly what to change. Anything that is not one
 * of the engine's refusals is a defect: it is logged, and the screen keeps the generic sentence.
 */
export function previewRefusal(err: unknown): string {
  if (err instanceof DriverRangeError) return 'An amount this driver computes is beyond the budget range: use a smaller amount or percentage.';
  if (err instanceof DriverRefError) return 'This driver cannot compute with these months, line or base month: check them, or Save to see what the server says.';
  log.error('Driver preview failed unexpectedly', { error: err }, 'budget-drivers');
  return 'The preview could not be computed for this driver.';
}

/** The months `candidate` would compute, with the version's other drivers as they stand. */
export function previewDriver(ctx: DriverContext, candidate: DriverLineInput, headcount: HeadcountLookup): PreviewResult {
  try {
    const line = normaliseLine(candidate);
    const key = rowKeyOfGrain(line);
    if (!known(ctx, line)) return { ok: false, kind: 'invalid', message: 'Pick an account the grid lists' };
    if (!known(ctx, line.ref)) return { ok: false, kind: 'invalid', message: 'Pick a row the grid lists to read from' };
    const others = ctx.drivers.filter((d) => rowKeyOfGrain(d) !== key);
    const pass = buildPass(ctx, [...others, line]);
    const missing = { any: false };
    const result = computeVersion({
      months: ctx.months, rows: pass.rows, cells: pass.cells, drivers: pass.defs,
      headcount: headcountFn(headcount, missing), closedMonths: ctx.closedMonths, rounding: ctx.rounding,
      frozenRows: otherHeadRows(pass, key),
    });
    const after = rowAfter(ctx, pass, key, result.writes);
    const warnings = result.warnings.filter((w) => w.rowKey === key).map((w) => w.message);
    return { ok: true, ...after, warnings, headcountMissing: missing.any };
  } catch (err) {
    if (err instanceof DriverCycleError) return { ok: false, kind: 'cycle', path: err.path };
    return { ok: false, kind: 'invalid', message: previewRefusal(err) };
  }
}

/**
 * What the row's driver computes in `month` now (cents), for an override cell's "Override of
 * driver value R x"; null when the row has no driver covering the month or the pass cannot run.
 */
export function driverValueOf(ctx: DriverContext, rowKey: RowKey, month: string, headcount: HeadcountLookup): number | null {
  const driver = ctx.drivers.find((d) => rowKeyOfGrain(d) === rowKey);
  if (!driver || month < driver.fromMonth || month > driver.toMonth || ctx.closedMonths.has(month)) return null;
  try {
    const pass = buildPass(ctx, ctx.drivers, rowKey);
    const missing = { any: false };
    const result = computeVersion({
      months: ctx.months, rows: pass.rows, cells: pass.cells, drivers: pass.defs,
      headcount: headcountFn(headcount, missing), closedMonths: ctx.closedMonths, rounding: ctx.rounding,
      frozenRows: otherHeadRows(pass, rowKey),
    });
    // A per_head figure without the headcount read would be a made-up 0.
    if (missing.any) return null;
    const after = rowAfter(ctx, pass, rowKey, result.writes);
    return after.values[ctx.months.indexOf(month)] ?? null;
  } catch {
    // A pass that cannot run (a driver the server skips) has no driver value to show; the mark says "driver value".
    return null;
  }
}
