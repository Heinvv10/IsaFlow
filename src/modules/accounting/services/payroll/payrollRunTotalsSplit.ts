/**
 * How a run's header totals split for the payroll journal — pure, no DB, so
 * the run page can show exactly the figures the journal books (W3-01 review).
 *
 * The header holds UIF as one combined figure. The journal books half as the
 * employee's deduction and the rest as the employer's cost (the two halves
 * sum to the total exactly, so an odd cent cannot unbalance it), and credits
 * 2175 with what is left of gross after PAYE, employee UIF and net pay.
 */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export interface RunTotalsSplit {
  employeeUif: number;
  employerUif: number;
  otherDeductions: number;
}

export function splitRunTotals(t: { gross: number; paye: number; uif: number; net: number }): RunTotalsSplit {
  const employeeUif = round2(t.uif / 2);
  const employerUif = round2(t.uif - employeeUif);
  return { employeeUif, employerUif, otherDeductions: round2(t.gross - t.paye - employeeUif - t.net) };
}
