/**
 * The employer's retirement fund contributions a pay run must book (wave 5 RF): each line's NON-CASH 3817 / 3825 / 3828
 * breakdown items (employerContributions.ts). Like the employer's 3810 (payrollJournalEmployerMedical), the amount is outside
 * gross pay and net pay, but the employer pays it to the fund: the journal debits it to labour (on the employee's own split
 * share) and credits it to 2175 on its own line, payable to the fund beside the employee's own 4001 / 4003 / 4006 (a net
 * claw-back is a 2175 debit). A cash 3817 (a pre-RF row kept as cash, migration 975) is already in gross: not here.
 * Both kinds come from one query (runEmployerNonCash), scoped by company through the run header.
 */
import { runEmployerNonCash } from './payrollJournalEmployerMedical';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const total = (m: ReadonlyMap<string, number>): number => round2([...m.values()].reduce((s, n) => s + n, 0));

/** Employee id → that employee's non-cash 3817 / 3825 / 3828 total on the run, cent-rounded; employees with none are absent. */
export async function runEmployerRetirement(companyId: string, runId: string): Promise<Map<string, number>> {
  return (await runEmployerNonCash(companyId, runId)).retirement;
}

/**
 * What the employer pays on top of gross for the run's non-cash employer contributions: the medical scheme's 3810 and the
 * funds' 3817 / 3825 / 3828, in total each, and per employee together (the labour split puts both on the employee's share).
 */
export async function runEmployerFundedCosts(companyId: string, runId: string): Promise<{ byEmployee: Map<string, number>; medical: number; retirement: number }> {
  const { medical, retirement } = await runEmployerNonCash(companyId, runId);
  const byEmployee = new Map(medical);
  for (const [id, n] of retirement) byEmployee.set(id, round2((byEmployee.get(id) ?? 0) + n));
  return { byEmployee, medical: total(medical), retirement: total(retirement) };
}
