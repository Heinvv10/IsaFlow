/**
 * The description a regular pay run's journal carries ("Payroll run 2026-10"). One definition: the journal plan sets it
 * (payrollJournalBuilder) and the salary bank file binds its anchor journal to the run by it (payrollBankFileJudge).
 */
export function payrollRunJournalDescription(periodYear: number, periodMonth: number): string {
  return `Payroll run ${periodYear}-${String(periodMonth).padStart(2, '0')}`;
}
