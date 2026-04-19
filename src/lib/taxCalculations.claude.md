# `src/lib/taxCalculations.ts`

## Purpose
Pure South African SARS lump-sum tax calculations (retirement/severance) — no DB dependencies; safe to import from UI components or server-side services.

## Key exports

- `calculateLumpSumTax(grossAmount, directiveRate) → LumpSumCalculation` — computes tax using either a SARS directive rate (flat percentage) or the default bracket table. Returns a full breakdown.
- `LumpSumCalculation` — `{ grossAmount, taxableAmount, taxAmount, effectiveRate, directiveRateUsed, breakdown[] }`
- `LumpSumBracket` — `{ from, to, rate, label }`

## Bracket table (2024 SARS)
| Range | Rate |
|---|---|
| R0 – R500 000 | 0% |
| R500 001 – R700 000 | 18% |
| R700 001 – R1 050 000 | 27% |
| Over R1 050 000 | 36% |

## Dependencies
None.

## Critical notes
- **Directive rate takes precedence**: if `directiveRate` is a non-negative number, brackets are ignored entirely. Pass `null` to use brackets.
- **2024 tax year only**: the bracket thresholds and rates are hardcoded. When SARS updates these figures for a new tax year, this file must be updated and all cached report results invalidated.
- **Rounding**: all monetary outputs are rounded to 2 decimal places (`Math.round(x * 100) / 100`). Intermediate accumulation uses full precision to minimise rounding error.
- **No validation on `grossAmount`**: callers are responsible for ensuring the input is a non-negative number. Negative inputs produce negative tax amounts.
- **`taxableAmount === grossAmount`**: the current implementation does not model the R500 000 lifetime exemption offset (which depends on prior lump sums). If cumulative exemption logic is needed, extend `calculateLumpSumTax` with a `priorLumpSums` parameter.
- **UI safe**: no Node.js APIs used — can be imported in browser bundles without issues.
