/**
 * The employer's retirement fund contributions a pay run must book (wave 5 RF): each line's NON-CASH 3817 / 3825 / 3828
 * breakdown items (employerContributions.ts). Like the employer's 3810 (payrollJournalEmployerMedical), the amount is outside
 * gross pay and net pay, but the employer pays it to the fund: the journal debits it to labour (on the employee's own split
 * share) and credits it to 2175 on its own line, payable to the fund beside the employee's own 4001 / 4003 / 4006.
 * A cash 3817 (a line not assembled by a run) is already in gross: not here. Scoped by company through the run header.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { runEmployerMedical } from './payrollJournalEmployerMedical';

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Employee id → that employee's non-cash 3817 / 3825 / 3828 total on the run, cent-rounded; employees with none are absent. */
export async function runEmployerRetirement(companyId: string, runId: string): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT l.employee_id, COALESCE(SUM((item->>'amount')::numeric), 0) AS employer_retirement
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.component_breakdown) = 'array'
        THEN l.component_breakdown ELSE '[]'::jsonb END) item
     WHERE l.run_id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
       AND item->>'isNonCash' = 'true'
       AND regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') IN ('3817', '3825', '3828')
     GROUP BY l.employee_id
     ORDER BY l.employee_id
  `) as DbRow[];
  const out = new Map<string, number>();
  for (const r of rows) {
    const amount = round2(Number(r.employer_retirement) || 0);
    if (amount !== 0) out.set(String(r.employee_id), amount);
  }
  return out;
}

const total = (m: ReadonlyMap<string, number>): number => round2([...m.values()].reduce((s, n) => s + n, 0));

/**
 * What the employer pays on top of gross for the run's non-cash employer contributions: the medical scheme's 3810 and the
 * funds' 3817 / 3825 / 3828, in total each, and per employee together (the labour split puts both on the employee's share).
 */
export async function runEmployerFundedCosts(companyId: string, runId: string): Promise<{ byEmployee: Map<string, number>; medical: number; retirement: number }> {
  const medical = await runEmployerMedical(runId);
  const retirement = await runEmployerRetirement(companyId, runId);
  const byEmployee = new Map(medical);
  for (const [id, n] of retirement) byEmployee.set(id, round2((byEmployee.get(id) ?? 0) + n));
  return { byEmployee, medical: total(medical), retirement: total(retirement) };
}
