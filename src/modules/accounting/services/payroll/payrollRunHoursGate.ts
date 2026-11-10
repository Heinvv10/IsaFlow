/**
 * The approval gate's refusal for hours and days (HD), read off the stored lines' validation results: an hourly or daily
 * employee with no hours or days recorded (HOURS_MISSING, `hours_missing`), and a line whose hours cannot be trusted:
 * a row for another pay basis (HOURS_UNIT_MISMATCH), two rows (HOURS_DUPLICATE) or another Basic Salary row beside the
 * hours (HOURS_WITH_OTHER_BASIC), all `hours_inconsistent`. Read-only. Judged before the journal-in-force branch of the
 * gate, so a re-approval of a reopened run meets it too.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import type { PayrollJournalNote } from './payrollJournalBuilder';

const CODES = ['HOURS_MISSING', 'HOURS_UNIT_MISMATCH', 'HOURS_DUPLICATE', 'HOURS_WITH_OTHER_BASIC'];

/**
 * A line a build WITHOUT the hours rules costed, stamped with today's calculation version all the same (two PRs bumping
 * the version to the same number would do it): an hourly or daily employee, employed in the period, whose line has no
 * quantity on any item and none of the HOURS_* results the calculator always gives such a line. Not producible by this
 * calculator, so the run must be recalculated. Severance-only leavers (ended before the period) are exempt.
 */
async function lineWithoutHoursRules(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const rows = (await sql`
    SELECT e.employee_number
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND e.pay_basis <> 'monthly'
      AND (e.end_date IS NULL OR e.end_date >= pg_catalog.make_date(h.period_year, h.period_month, 1))
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l.component_breakdown) i WHERE i ? 'quantity')
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(l.validation_results) v WHERE v->>'code' = ANY(${CODES}::text[]))
    ORDER BY e.employee_number
  `) as DbRow[];
  if (rows.length === 0) return null;
  return {
    code: 'recalculate_required',
    detail: `The lines of ${rows.map((r) => String(r.employee_number)).join(', ')} (paid by the hour or day) were costed without the hours rules. Recalculate this run, then approve.`,
  };
}

export async function hoursMissingBlocker(companyId: string, runId: string): Promise<PayrollJournalNote | null> {
  const stale = await lineWithoutHoursRules(companyId, runId);
  if (stale) return stale;
  const rows = (await sql`
    SELECT e.employee_number, v->>'code' AS code, v->>'message' AS message
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    CROSS JOIN LATERAL jsonb_array_elements(l.validation_results) AS v
    WHERE h.id = ${runId}::uuid AND h.company_id = ${companyId}::uuid
      AND v->>'code' = ANY(${CODES}::text[])
    ORDER BY e.employee_number, v->>'code'
  `) as DbRow[];
  if (rows.length === 0) return null;
  const missing = rows.filter((r) => String(r.code) === 'HOURS_MISSING');
  if (missing.length > 0) {
    return {
      code: 'hours_missing',
      detail: `These employees are paid by the hour or day and this run records none for them: ${missing.map((r) => String(r.employee_number)).join(', ')}. `
        + 'Enter their hours or days on the pay run (0 if none were worked), then approve.',
    };
  }
  return { code: 'hours_inconsistent', detail: rows.map((r) => `${String(r.employee_number)}: ${String(r.message)}`).join(' ') };
}
