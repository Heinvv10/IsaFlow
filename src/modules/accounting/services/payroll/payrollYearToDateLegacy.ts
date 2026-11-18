/**
 * The pre-948 legacy split of a year-to-date line (payrollYearToDate.ts): the
 * taxable split restored from the breakdown, and the periods it restores.
 * Moved out of payrollYearToDate.ts unchanged (wave-6 AN, refactor(split)).
 */

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
  const restored = Object.keys(unpaidLines).filter(id => (restoredPeriodicByLine[id] ?? 0) > 0);
  return withPeriodicPay + restored.length;
}
