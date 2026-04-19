import Decimal from 'decimal.js';
import type { LoanInputs, RatePoint } from './types';

Decimal.set({ precision: 20, rounding: Decimal.ROUND_HALF_UP });

/** Excel-compatible PMT: returns negative (cash-out convention). */
export function pmt(rate: Decimal, nper: number, pv: Decimal, fv: Decimal): Decimal {
  if (rate.isZero()) {
    return pv.plus(fv).div(nper).negated();
  }
  const q = rate.plus(1).pow(nper);
  // PMT = -rate * (pv * (1+rate)^n + fv) / ((1+rate)^n - 1)
  return rate.times(pv.times(q).plus(fv)).div(q.minus(1)).negated();
}

/**
 * Returns -PMT(rate/12, nper, pv, -residual).
 * Positive value = installment amount.
 */
export function solveInstallment(
  annualRate: Decimal,
  nper: number,
  pv: Decimal,
  residual: Decimal,
): Decimal {
  const monthlyRate = annualRate.div(1200); // annual% / 12 / 100
  const pmtVal = pmt(monthlyRate, nper, pv, residual.negated());
  return pmtVal.negated(); // positive installment
}

/** Looks up the prime rate for a given period date from sorted curve points. */
export function lookupRate(
  curve: RatePoint[],
  periodDate: string,
  loan: Pick<LoanInputs, 'rateMode' | 'margin' | 'fixedRate'>,
): { rate: Decimal; extrapolated: boolean } {
  if (loan.rateMode === 'FIXED') {
    return { rate: new Decimal(loan.fixedRate ?? 0), extrapolated: false };
  }

  const sorted = [...curve].sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));
  if (sorted.length === 0) {
    throw new Error('Rate curve is empty');
  }

  // Find largest effectiveDate ≤ periodDate
  let found: RatePoint | null = null;
  for (const pt of sorted) {
    if (pt.effectiveDate <= periodDate) found = pt;
    else break;
  }

  const lastPoint = sorted[sorted.length - 1]!;
  const extrapolated = found === null || periodDate > lastPoint.effectiveDate;
  const baseRate = new Decimal((found ?? sorted[0]!).rate);
  const margin = new Decimal(loan.margin);

  const rate =
    loan.rateMode === 'PRIME_PLUS' ? baseRate.plus(margin) : baseRate.minus(margin);

  return { rate, extrapolated };
}
