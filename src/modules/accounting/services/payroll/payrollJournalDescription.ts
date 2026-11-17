/**
 * The description a regular pay run's journal carries ("Payroll run 2026-10"). One definition: the journal plan sets it
 * (payrollJournalBuilder) and the salary bank file binds its anchor journal to the run by it (payrollBankFileJudge).
 */
export function payrollRunJournalDescription(periodYear: number, periodMonth: number, offCycleReason: string | null = null): string {
  // An off-cycle run's journal names its kind (wave 6 OC): "Payroll run 2026-10 bonus", so no reader takes it for the
  // month's regular run (payrollJournalReversalGuard reads an off-cycle journal's run by its link only).
  return `Payroll run ${periodYear}-${String(periodMonth).padStart(2, '0')}${offCycleReason ? ` ${offCycleReason}` : ''}`;
}
