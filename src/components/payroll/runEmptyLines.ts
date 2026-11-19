/**
 * What a run with no lines says (wave 6 FQd, review #1622 UI L4). Never calculated: press Calculate. Calculated and
 * still empty: nobody is paid at the run's frequency, so say that and where it is set (a fortnightly run with no
 * fortnightly employee costs nobody, and "press Calculate" would send the user round in circles).
 */
export function emptyLinesMessage(run: { status: string; payFrequency?: string }, canCalculate: boolean): string {
  if (run.status === 'calculated') {
    return `No employee is paid ${run.payFrequency ?? 'monthly'}, so nobody is on this run. Set the pay frequency on the employee's profile, then recalculate.`;
  }
  return canCalculate ? 'No lines yet. Press Calculate to generate payroll for this period.' : 'No lines yet.';
}
