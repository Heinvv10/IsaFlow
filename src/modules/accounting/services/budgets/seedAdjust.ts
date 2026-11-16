/**
 * Per-account and per-section seed adjustments (PURE): what the wizard's single uplift becomes when a
 * caller (the MCP `seed_budget` tool) also names an uplift per section or per account, a fixed annual
 * amount per account, or a flat seasonality. Without adjustments `seedVersion` never calls this: the
 * wizard's numbers stay exactly what they were.
 *
 * Per series (one account at one dimension member), in this order:
 *  - a FIXED annual amount for the account replaces the uplift: split across the account's series by
 *    the source's share of each (`splitByWeights`, residue on the last), then spread by the source's own
 *    monthly shape (`seasonality: 'actuals'`, `spreadSeasonal`, over the months the source holds) or
 *    evenly over EVERY month of the target year (`'flat'`, `spreadEven`). A source with nothing to take a
 *    share or a shape from is refused naming the account (never guessed);
 *  - else the account's uplift %, else its section's (band), else the seed's own, through the wizard's
 *    `uplift` (target rounded to the unit, residue on the last month); with `'flat'` the uplifted total is
 *    then spread evenly over every month of the target year.
 * An account named by an adjustment with no row in the source is refused (fixed or uplift alike). Every
 * refusal is a 400 naming the account, raised before anything is written.
 */
import type { RoundingUnit } from './grid/cents';
import { residueFlipsSign, splitByWeights, spreadEven, spreadSeasonal, uplift, type SpreadResult } from './grid/spread';
import type { Band } from './grid/subtotals';
import { inputError } from './gridErrors';
import type { SeedSeries } from './seedSeriesCore';

export type Seasonality = 'actuals' | 'flat';

export interface SeedAdjustments {
  /** Account id → uplift %. */
  accountUplift?: ReadonlyMap<string, number>;
  sectionUplift?: ReadonlyMap<Band, number>;
  /** Account id → the annual amount in integer cents (replaces the uplift). */
  fixedAnnual?: ReadonlyMap<string, number>;
  /** Default 'actuals': the source's own monthly shape. */
  seasonality?: Seasonality;
}

/** One seeded cell: the series it belongs to, its position in the TARGET year's months, its cents. */
export interface SeedCell { series: SeedSeries; position: number; cents: number }

/** What the adjustments need to know of an account (seedSeries' SeedAccount has it). */
export interface SeedAccountInfo { label: string; band: Band | null }

const total = (cents: readonly number[]): number => cents.reduce((s, c) => s + c, 0);
const allMonths = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** The seed's cells with the adjustments applied over a target year of `monthCount` months. */
export function adjustSeedSeries(
  series: readonly SeedSeries[], basePct: number, unit: RoundingUnit, adjust: SeedAdjustments,
  accounts: ReadonlyMap<string, SeedAccountInfo>, monthCount: number,
): SeedCell[] {
  const seasonality = adjust.seasonality ?? 'actuals';
  const label = (id: string) => accounts.get(id)?.label ?? id;
  const byAccount = new Map<string, SeedSeries[]>();
  for (const s of series) byAccount.set(s.glAccountId, [...(byAccount.get(s.glAccountId) ?? []), s]);
  for (const [what, ids] of [['a fixed amount', adjust.fixedAnnual?.keys()], ['an uplift', adjust.accountUplift?.keys()]] as const) {
    for (const id of ids ?? []) {
      if (!byAccount.has(id)) {
        throw inputError(`Account ${label(id)} has no row in the seed's source to place ${what} on: set include_no_activity, or set it with set_budget_annual after the seed`);
      }
    }
  }
  const out: SeedCell[] = [];
  /** Pushes `result` onto `positions` (the series' own months, or every month of the year when flat). */
  const push = (s: SeedSeries, result: SpreadResult, positions: readonly number[], why: string) => {
    if (!result.ok) throw inputError(`Account ${label(s.glAccountId)}: ${why}${result.reason}`);
    result.months.forEach((cents, i) => out.push({ series: s, position: positions[i]!, cents }));
  };
  const flat = (s: SeedSeries, target: number) => push(s, spreadEven(target, monthCount, unit), allMonths(monthCount), '');
  for (const [accountId, rows] of byAccount) {
    const fixed = adjust.fixedAnnual?.get(accountId);
    if (fixed !== undefined) {
      const split = rows.length === 1 ? { ok: true as const, parts: [fixed] } : splitByWeights(fixed, rows.map((r) => total(r.cents)), unit);
      if (!split.ok) throw inputError(`Account ${label(accountId)}: the fixed amount cannot be shared across its ${rows.length} dimension rows: ${split.reason}`);
      rows.forEach((r, i) => (seasonality === 'flat'
        ? flat(r, split.parts[i]!)
        : push(r, spreadSeasonal(split.parts[i]!, r.cents, unit), r.positions, 'the source gives no monthly shape (use seasonality flat). ')));
      continue;
    }
    const band = accounts.get(accountId)?.band ?? null;
    const pct = adjust.accountUplift?.get(accountId) ?? (band ? adjust.sectionUplift?.get(band) : undefined) ?? basePct;
    for (const r of rows) {
      const lifted = uplift(r.cents, pct, unit);
      if (!lifted.ok || seasonality === 'actuals') push(r, lifted, r.positions, '');
      else flat(r, total(lifted.months));
    }
  }
  return out;
}

/**
 * The accounts whose LAST seeded month the rounding put on the other side of zero (the wizard preview's
 * notice, seedPreview.ts): per series, unless the source's own last month already had that sign.
 */
export function roundingFlips(cells: readonly SeedCell[], labels: ReadonlyMap<string, string>): string[] {
  const bySeries = new Map<SeedSeries, SeedCell[]>();
  for (const c of cells) bySeries.set(c.series, [...(bySeries.get(c.series) ?? []), c]);
  const flips = new Set<string>();
  for (const [s, list] of bySeries) {
    const months = [...list].sort((a, b) => a.position - b.position).map((c) => c.cents);
    const natural = Math.sign(s.cents[s.cents.length - 1] ?? 0) === Math.sign(months[months.length - 1] ?? 0);
    if (!natural && residueFlipsSign(total(months), months)) flips.add(labels.get(s.glAccountId) ?? s.glAccountId);
  }
  return [...flips].sort();
}
