/**
 * The employer's medical scheme contribution a pay run must book: each line's NON-CASH 3810 breakdown items.
 *
 * A 3810 earning without the gross-up record is the employer's share of the premium (employerContributions.ts): flagged
 * `isNonCash`, so it is outside gross pay and net pay. Unlike the 3801 loan or 3802 vehicle benefit, money does move: the
 * employer pays that share to the scheme. So the journal books it as labour cost (DR, on the employee's own split share)
 * and as scheme payable on 2175 beside the employee's 4005 (CR). A cash 3810 (gross-up) is already in gross: not here.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/**
 * One read of the run's NON-CASH employer contributions, by employee: the medical scheme's 3810 and (wave 5 RF) the funds'
 * 3817 / 3825 / 3828 (payrollJournalEmployerRetirement). Cent-rounded; an employee with nil of a kind is absent from that map.
 * Scoped by company through the run header.
 */
export async function runEmployerNonCash(companyId: string, runId: string): Promise<{ medical: Map<string, number>; retirement: Map<string, number> }> {
  const rows = (await sql`
    SELECT x.employee_id,
           COALESCE(SUM(x.amount) FILTER (WHERE x.code = '3810'), 0) AS employer_medical,
           COALESCE(SUM(x.amount) FILTER (WHERE x.code IN ('3817', '3825', '3828')), 0) AS employer_retirement
      FROM (
        SELECT l.employee_id, (item->>'amount')::numeric AS amount,
               regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS code
          FROM payroll_run_lines l
          JOIN payroll_run_headers h ON h.id = l.run_id
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.component_breakdown) = 'array'
            THEN l.component_breakdown ELSE '[]'::jsonb END) item
         WHERE l.run_id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
           AND item->>'isNonCash' = 'true'
      ) x
     GROUP BY x.employee_id
     ORDER BY x.employee_id
  `) as DbRow[];
  const medical = new Map<string, number>();
  const retirement = new Map<string, number>();
  for (const r of rows) {
    const m = Math.round((Number(r.employer_medical) || 0) * 100) / 100;
    const f = Math.round((Number(r.employer_retirement) || 0) * 100) / 100;
    if (m !== 0) medical.set(String(r.employee_id), m);
    if (f !== 0) retirement.set(String(r.employee_id), f);
  }
  return { medical, retirement };
}

/** Employee id → that employee's non-cash 3810 total on the run, cent-rounded; employees with none are absent. */
export async function runEmployerMedical(companyId: string, runId: string): Promise<Map<string, number>> {
  return (await runEmployerNonCash(companyId, runId)).medical;
}

export function employerMedicalTotal(byEmployee: ReadonlyMap<string, number>): number {
  return Math.round([...byEmployee.values()].reduce((s, n) => s + n, 0) * 100) / 100;
}
