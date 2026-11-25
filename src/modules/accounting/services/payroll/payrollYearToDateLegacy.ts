/**
 * The pre-948 legacy split of a year-to-date line (payrollYearToDate.ts): the
 * taxable split restored from the breakdown, and the periods it restores.
 * Moved out of payrollYearToDate.ts unchanged (wave-6 AN, refactor(split)); FQe adds the by-frequency counts.
 */
import type { PayFrequency } from './payrollTypesRun';

export function restoreLegacyTaxableSplit(
  taxableSplits: Record<string, unknown>,
  legacyTaxableByLine: Record<string, number>,
): { periodic: number; annual: number; periodicByLine: Record<string, number> } {
  let periodic = 0;
  let annual = 0;
  const periodicByLine: Record<string, number> = {};
  for (const [lineId, deduction] of Object.entries(legacyTaxableByLine)) {
    const split = (taxableSplits[lineId] ?? {}) as Record<string, unknown>;
    // The old calculator floored taxable remuneration at nil, so a contribution
    // larger than the line's taxable earnings did not reduce PAYE by its full amount.
    const restorable = Math.min(deduction, Math.max(0, Number(split.originalTaxable)));
    // The old calculator consumed periodic pay first. Therefore any gap between
    // the gross 3605 amount and its stored annual amount is the deduction's
    // excess; only the remainder can be restored to periodic remuneration.
    const annualGap = Math.max(0, Number(split.annualGross) - Number(split.annual));
    const annualRestored = Math.min(restorable, annualGap);
    const periodicRestored = Math.max(0, restorable - annualRestored);
    annual += annualRestored;
    periodic += periodicRestored;
    if (periodicRestored > 0) periodicByLine[lineId] = periodicRestored;
  }
  return { periodic, annual, periodicByLine };
}

/**
 * The periods to date: the lines with stored periodic pay, plus those without
 * whose pre-948 taxable retirement contributions restore periodic pay (the old
 * calculator took deductions off periodic pay first, so a contribution as large
 * as the pay left it nil). A bonus-only or severance-only line stays no period.
 */
export function yearToDatePeriods(
  withPeriodicPay: number,
  unpaidLines: Record<string, unknown>,
  restoredPeriodicByLine: Record<string, number>,
): number {
  return withPeriodicPay + restoredPeriodLineIds(unpaidLines, restoredPeriodicByLine).length;
}

/** The lines yearToDatePeriods counts again: no stored periodic pay, and a restored periodic amount. */
export function restoredPeriodLineIds(unpaidLines: Record<string, unknown>, restoredPeriodicByLine: Record<string, number>): string[] {
  return Object.keys(unpaidLines).filter(id => (restoredPeriodicByLine[id] ?? 0) > 0);
}

/**
 * FQe (engine 23): the reader's periods by frequency (jsonb, each its own frequency's periods) plus one period per
 * restored line, in that line's run frequency (`frequencyOf`, by line id). A line whose frequency is not one of the three
 * cannot be on a costed run (payroll_run_headers.pay_frequency CHECK); it would be counted as monthly.
 */
export function withRestored(
  byFrequency: unknown, restoredLineIds: readonly string[], frequencyOf: Record<string, unknown>,
): Partial<Record<PayFrequency, number>> {
  const raw = (byFrequency ?? {}) as Record<string, unknown>;
  const out: Partial<Record<PayFrequency, number>> = {};
  for (const f of ['weekly', 'fortnightly', 'monthly'] as const) {
    const n = Number(raw[f] ?? 0);
    if (n !== 0) out[f] = n;
  }
  for (const id of restoredLineIds) {
    const f = frequencyOf[id];
    const key: PayFrequency = f === 'weekly' || f === 'fortnightly' ? f : 'monthly';
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}
