/**
 * The run page tells the period strip (in AppLayout, mounted once per visit) that a run's status moved, so the strip
 * does not keep saying "Calculated" after an approval. A window event: the two share no React parent.
 */
export const PAYROLL_RUN_CHANGED = 'isaflow:payroll-run-changed';

export function announcePayrollRunChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PAYROLL_RUN_CHANGED));
}
