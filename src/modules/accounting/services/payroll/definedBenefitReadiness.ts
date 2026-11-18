/**
 * DBF IRP5 readiness (coordinator ruling on #1571): a para 12D(6) member (db_member_retired) whose line also carried 4001 /
 * 4003 contributions. BRS PAYE Employer Reconciliation V25.3.0 p. 54: "If code 4585 is greater than zero and code 4472 is
 * equal to zero, then codes 3817/3867 and 4001 must be zero" (4586 / 4473 / 3825 / 4003 alike), so that certificate would not
 * validate. The run warned DB_FUND_RETIRED_MEMBER_4001 at calculate (definedBenefitFund.ts) and was not refused; the year-end
 * readiness (IRP5 summary, year-end status) refuses the employee's certificate with an error naming them. Read from the final
 * runs' lines of the tax year, as the certificate is. UNVERIFIED against SARS's own validator.
 */
import { sql, type DbRow } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import type { ValidationMessage } from './irp5ValidationEngine';

export const RETIRED_MEMBER_4001 = 'DB_FUND_RETIRED_MEMBER_4001';

/** Employee ids whose final lines in the tax year (`bounds`, payeTaxYearBounds) carry DB_FUND_RETIRED_MEMBER_4001. */
export async function listRetiredMemberWith4001(companyId: string, bounds: { start: string; end: string }): Promise<Set<string>> {
  const rows = (await sql`
    SELECT DISTINCT l.employee_id
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
     WHERE h.company_id = ${companyId}::uuid
       AND ${sql.unsafe(payRunFinalSql('h'))}
       AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
       AND COALESCE(l.validation_results @> ${JSON.stringify([{ code: RETIRED_MEMBER_4001 }])}::jsonb, false)
  `) as DbRow[];
  return new Set(rows.map((r) => String(r.employee_id)));
}

/** The readiness error for one employee, named. */
export function retiredMember4001Message(employee: string): ValidationMessage {
  return {
    severity: 'error', code: 'IRP5_DB_RETIRED_MEMBER_4001', field: '4001',
    message: `${employee}: a retired defined-benefit fund member (para 12D(6), reported as 4585 / 4586) also had pension or provident `
      + 'contributions (4001 / 4003) this tax year. BRS V25.3.0 p. 54: "4001 must be zero" when 4585 is above nil and 4472 is nil, so the '
      + 'certificate will not validate. Correct the assignments and the affected runs before filing. UNVERIFIED.',
  };
}
