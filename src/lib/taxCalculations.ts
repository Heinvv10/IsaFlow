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

// SA SARS retirement/severance lump sum brackets (2024)
const LUMP_SUM_BRACKETS: LumpSumBracket[] = [
  { from: 0,         to: 500_000,   rate: 0.00, label: 'R0 – R500,000 (0%)' },
  { from: 500_000,   to: 700_000,   rate: 0.18, label: 'R500,001 – R700,000 (18%)' },
  { from: 700_000,   to: 1_050_000, rate: 0.27, label: 'R700,001 – R1,050,000 (27%)' },
  { from: 1_050_000, to: null,      rate: 0.36, label: 'Over R1,050,000 (36%)' },
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
