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

/** Employee id → that employee's non-cash 3810 total on the run, cent-rounded; employees with none are absent. */
export async function runEmployerMedical(runId: string): Promise<Map<string, number>> {
  const rows = (await sql`
    SELECT l.employee_id, COALESCE(SUM((item->>'amount')::numeric), 0) AS employer_medical
      FROM payroll_run_lines l
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.component_breakdown) = 'array'
        THEN l.component_breakdown ELSE '[]'::jsonb END) item
     WHERE l.run_id = ${runId}::uuid
       AND item->>'isNonCash' = 'true'
       AND regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3810'
     GROUP BY l.employee_id
     ORDER BY l.employee_id
  `) as DbRow[];
  const out = new Map<string, number>();
  for (const r of rows) {
    const amount = Math.round((Number(r.employer_medical) || 0) * 100) / 100;
    if (amount !== 0) out.set(String(r.employee_id), amount);
  }
  return out;
}

export function employerMedicalTotal(byEmployee: ReadonlyMap<string, number>): number {
  return Math.round([...byEmployee.values()].reduce((s, n) => s + n, 0) * 100) / 100;
}
