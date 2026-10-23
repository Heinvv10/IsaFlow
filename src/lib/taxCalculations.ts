/**
 * Pure SA tax calculation utilities — no DB dependencies, safe to import from UI components.
 */

export interface LumpSumBracket {
  from: number;
  to: number | null;
  rate: number;
  label: string;
}

export interface LumpSumCalculation {
  grossAmount: number;
  taxableAmount: number;
  taxAmount: number;
  effectiveRate: number;
  directiveRateUsed: boolean;
  breakdown: Array<{ bracket: string; amount: number; tax: number; rate: number }>;
}

/** The tax year LUMP_SUM_BRACKETS are for (1 March 2026 – 28 February 2027). */
export const LUMP_SUM_TAX_YEAR = 2027;

// SARS "Retirement fund lump sum benefits or severance benefits" table, 2027
// tax year (unchanged since 2024): https://www.sars.gov.za/tax-rates/income-tax/retirement-lump-sum-benefits/
// (retrieved 2026-10-22). 1 – 550 000: 0%; 550 001 – 770 000: 18% above
// 550 000; 770 001 – 1 155 000: 39 600 + 27% above 770 000; 1 155 001 and
// above: 143 550 + 36% above 1 155 000. The only copy in the codebase: the pay
// run never taxes a lump sum from a table, only at its directive's figures
// (payrollSeveranceDirective). An estimate: SARS aggregates earlier lump sums,
// which this does not see.
const LUMP_SUM_BRACKETS: LumpSumBracket[] = [
  { from: 0,         to: 550_000,   rate: 0.00, label: 'R0 – R550,000 (0%)' },
  { from: 550_000,   to: 770_000,   rate: 0.18, label: 'R550,001 – R770,000 (18%)' },
  { from: 770_000,   to: 1_155_000, rate: 0.27, label: 'R770,001 – R1,155,000 (27%)' },
  { from: 1_155_000, to: null,      rate: 0.36, label: 'Over R1,155,000 (36%)' },
];

export function calculateLumpSumTax(
  grossAmount: number,
  directiveRate: number | null
): LumpSumCalculation {
  if (directiveRate !== null && directiveRate >= 0) {
    const taxAmount = grossAmount * directiveRate;
    return {
      grossAmount,
      taxableAmount: grossAmount,
      taxAmount: Math.round(taxAmount * 100) / 100,
      effectiveRate: directiveRate,
      directiveRateUsed: true,
      breakdown: [
        {
          bracket: `Directive rate (${(directiveRate * 100).toFixed(2)}%)`,
          amount: grossAmount,
          tax: Math.round(taxAmount * 100) / 100,
          rate: directiveRate,
        },
      ],
    };
  }

  let remaining = grossAmount;
  let totalTax = 0;
  const breakdown: LumpSumCalculation['breakdown'] = [];

  for (const bracket of LUMP_SUM_BRACKETS) {
    if (remaining <= 0) break;
    const bracketSize = bracket.to !== null ? bracket.to - bracket.from : Infinity;
    const taxable = Math.min(remaining, bracketSize);
    const tax = taxable * bracket.rate;
    breakdown.push({
      bracket: bracket.label,
      amount: Math.round(taxable * 100) / 100,
      tax: Math.round(tax * 100) / 100,
      rate: bracket.rate,
    });
    totalTax += tax;
    remaining -= taxable;
  }

  const roundedTax = Math.round(totalTax * 100) / 100;
  return {
    grossAmount,
    taxableAmount: grossAmount,
    taxAmount: roundedTax,
    effectiveRate: grossAmount > 0 ? roundedTax / grossAmount : 0,
    directiveRateUsed: false,
    breakdown,
  };
}
