/**
 * The approval gate's refusal for hours and days (HD): an hourly or daily employee whose stored line has no hours
 * or days recorded (the calculator's HOURS_MISSING). Such a line pays nothing for basic pay, which is never what
 * the run means, so approval stops until the hours are entered. Read-only, off the stored lines.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PayrollJournalNote } from './payrollJournalBuilder';

export async function hoursMissingBlocker(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const rows = (await sql`
    SELECT e.employee_number
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND l.validation_results @> '[{"code":"HOURS_MISSING"}]'::jsonb
    ORDER BY e.employee_number
  `) as DbRow[];
  if (rows.length === 0) return null;
  return {
    code: 'hours_missing',
    detail: `These employees are paid by the hour or day and this run records none for them: ${rows.map((r) => String(r.employee_number)).join(', ')}. `
      + 'Enter their hours or days on the pay run, then approve.',
  };
}
