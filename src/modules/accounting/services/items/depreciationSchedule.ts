/**
 * The annual depreciation schedule shown on the asset detail page.
 *
 * Built from `annualPolicyCharge`, the same function the monthly run posts
 * from, so the table cannot contradict the journals. It used to charge
 * cost / years flat and ignore both the asset's method and its residual.
 */

import { annualPolicyCharge, toDepreciationMethod } from './depreciationMethods';

/** Rows past this are not rendered; a longer life is truncated, not trued up. */
const MAX_ROWS = 30;

export interface ScheduleRow {
  year: number;
  open: number;
  dep: number;
  close: number;
  accum: number;
}

export interface ScheduleAsset {
  purchase_price: number | null;
  useful_life_years: number | null;
  salvage_value: number | null;
  depreciation_method: string | null;
}

/**
 * Annual figures. Year one is BEFORE the run's first-month pro-rate, so the
 * twelve posted journals total slightly less than the first row.
 */
export function buildDepreciationSchedule(a: ScheduleAsset): ScheduleRow[] {
  const yrs = Number(a.useful_life_years ?? 0);
  const cost = Number(a.purchase_price ?? 0);
  if (!yrs || yrs <= 0 || cost <= 0) return [];

  const lifeYears = Math.ceil(yrs);
  const rowCount = Math.min(lifeYears, MAX_ROWS);
  const residual = Number(a.salvage_value ?? 0);
  const method = toDepreciationMethod(a.depreciation_method);

  let accum = 0;
  return Array.from({ length: rowCount }, (_, i) => {
    const year = i + 1;
    const open = cost - accum;
    const charge = annualPolicyCharge({
      method, cost, residual, usefulLifeYears: yrs, monthsElapsed: i * 12,
    });
    // The LAST YEAR OF THE LIFE trues up onto the residual, as the run does —
    // not the last row shown. Truing up at row 30 of a 40-year life invented a
    // write-off the run never posts.
    const remaining = open - residual;
    const dep = Math.max(0, Math.min(year === lifeYears ? remaining : charge, remaining));
    accum += dep;
    return { year, open, dep, close: Math.max(residual, cost - accum), accum };
  });
}
