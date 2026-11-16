/**
 * Per-account and per-section seed adjustments (PURE): what the wizard's single uplift becomes when a
 * caller (the MCP `seed_budget` tool) also names an uplift per section or per account, a fixed annual
 * amount per account, or a flat seasonality. Without adjustments `seedVersion` never calls this: the
 * wizard's numbers stay exactly what they were.
 *
 * Per series (one account at one dimension member), in this order:
 *  - a FIXED annual amount for the account replaces the uplift: split across the account's series by
 *    the source's share of each (`splitByWeights`, residue on the last), then spread over the series'
 *    months by the source's own monthly shape (`seasonality: 'actuals'`, `spreadSeasonal`) or evenly
 *    (`'flat'`, `spreadEven`). A source with nothing to take a share or a shape from is refused naming
 *    the account (never guessed);
 *  - else the account's uplift %, else its section's (band), else the seed's own, through the wizard's
 *    `uplift` (target rounded to the unit, residue on the last month); with `'flat'` the uplifted total
 *    is then spread evenly over the series' months.
 * Every refusal is a 400 naming the account, raised before anything is written.
 */
import type { RoundingUnit } from './grid/cents';
import { splitByWeights, spreadEven, spreadSeasonal, uplift, type SpreadResult } from './grid/spread';
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

export interface AdjustedCell { series: SeedSeries; position: number; cents: number }

export interface SeedAccountInfo { label: string; band: Band | null }

const total = (cents: readonly number[]): number => cents.reduce((s, c) => s + c, 0);

function months(series: SeedSeries, target: number, seasonality: Seasonality, unit: RoundingUnit): SpreadResult {
  if (seasonality === 'flat') return spreadEven(target, series.positions.length, unit);
  return spreadSeasonal(target, series.cents, unit);
}

/** The seed's cells with the adjustments applied; `accounts` names each account (messages) and gives its band. */
export function adjustSeedSeries(
  series: readonly SeedSeries[], basePct: number, unit: RoundingUnit, adjust: SeedAdjustments,
  accounts: ReadonlyMap<string, SeedAccountInfo>,
): AdjustedCell[] {
  const seasonality = adjust.seasonality ?? 'actuals';
  const label = (id: string) => accounts.get(id)?.label ?? id;
  const byAccount = new Map<string, SeedSeries[]>();
  for (const s of series) byAccount.set(s.glAccountId, [...(byAccount.get(s.glAccountId) ?? []), s]);
  for (const id of adjust.fixedAnnual?.keys() ?? []) {
    if (!byAccount.has(id)) {
      throw inputError(`Account ${label(id)} has no row in the seed's source to place a fixed amount on: set include_no_activity, or set it with set_budget_annual after the seed`);
    }
  }
  const out: AdjustedCell[] = [];
  const push = (s: SeedSeries, result: SpreadResult, why: string) => {
    if (!result.ok) throw inputError(`Account ${label(s.glAccountId)}: ${why}${result.reason}`);
    result.months.forEach((cents, i) => out.push({ series: s, position: s.positions[i]!, cents }));
  };
  for (const [accountId, rows] of byAccount) {
    const fixed = adjust.fixedAnnual?.get(accountId);
    if (fixed !== undefined) {
      const split = rows.length === 1 ? { ok: true as const, parts: [fixed] } : splitByWeights(fixed, rows.map((r) => total(r.cents)), unit);
      if (!split.ok) throw inputError(`Account ${label(accountId)}: the fixed amount cannot be shared across its ${rows.length} dimension rows: ${split.reason}`);
      rows.forEach((r, i) => push(r, months(r, split.parts[i]!, seasonality, unit), seasonality === 'actuals' ? 'the source gives no monthly shape (use seasonality flat). ' : ''));
      continue;
    }
    const band = accounts.get(accountId)?.band ?? null;
    const pct = adjust.accountUplift?.get(accountId) ?? (band ? adjust.sectionUplift?.get(band) : undefined) ?? basePct;
    for (const r of rows) {
      const lifted = uplift(r.cents, pct, unit);
      if (!lifted.ok || seasonality === 'actuals') { push(r, lifted, ''); continue; }
      push(r, spreadEven(total(lifted.months), r.positions.length, unit), '');
    }
  }
  return out;
}
