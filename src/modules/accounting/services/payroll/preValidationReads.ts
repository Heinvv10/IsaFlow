/**
 * The reads of IRP5 pre-validation (wave 6 PV). Everything comes from the same FINAL lines the certificate is built
 * from, never from today's assignments: the totals, the SARS codes actually paid (`component_breakdown[].sarsSourceCode`,
 * trimmed, as the certificate code reads them; a code whose items net to nil over the year is not paid), the non-cash
 * fringe benefits (`isNonCash`, outside gross_pay, floored per code) and any 3801 paid as cash. So a leaver whose components have ended, a once-off 3605 or 3901, and a past tax year are all
 * judged by what was paid. Every query carries the company.
 *
 * Final = `status IN ('approved','paid') AND COALESCE(approved_at, approval_grandfathered_at) IS NOT NULL` (wave-5 FS,
 * `payslipFinal.isPayRunFinal`), the one fragment `payRunFinalSql.ts`. A run scope also counts that run's lines.
 */
import { sql } from '@/lib/neon';
import { payRunFinalSql } from './payRunFinalSql';
import { payeTaxYearBounds, payeTaxYearPeriods } from '@/modules/accounting/utils/payeTaxYear';

export type PreValidationRow = {
  employee_id: string; employee_number: string; first_name: string; last_name: string;
  tax_number: string | null; id_number: string | null;
  gross: string; paye: string; uif: string; sdl: string; non_cash: string; unflagged_3801: string;
  codes: string[];
};

export async function loadFinalLineTotals(
  companyId: string, taxYear: number, employeeId: string | null, runId: string | null,
): Promise<PreValidationRow[]> {
  const p = payeTaxYearPeriods(taxYear);
  return (await sql`
    WITH lines AS (
      SELECT prl.employee_id, prl.gross_pay, prl.paye, prl.uif_employee, prl.uif_employer, prl.sdl,
             CASE WHEN jsonb_typeof(prl.component_breakdown) = 'array' THEN prl.component_breakdown ELSE '[]'::jsonb END AS items
        FROM payroll_run_lines prl
        JOIN payroll_run_headers prh ON prh.id = prl.run_id
       WHERE prh.company_id = ${companyId}::uuid
         AND (${sql.unsafe(payRunFinalSql('prh'))} OR prh.id = ${runId}::uuid)
         AND ((prh.period_year = ${p.startYear} AND prh.period_month >= ${p.startMonth})
              OR (prh.period_year = ${p.endYear} AND prh.period_month <= ${p.endMonth}))
         AND (${employeeId}::uuid IS NULL OR prl.employee_id = ${employeeId}::uuid)
         AND (${runId}::uuid IS NULL OR prl.employee_id IN (SELECT employee_id FROM payroll_run_lines WHERE run_id = ${runId}::uuid))
    ), items AS (
      SELECT l.employee_id,
             regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS code,
             (item->>'amount')::numeric AS amount,
             COALESCE(item->>'isNonCash' = 'true', false) AS non_cash
        FROM lines l CROSS JOIN LATERAL jsonb_array_elements(l.items) AS item
    ), code_net AS (
      -- A code counts as paid only if its items net to non-zero over the year (a 3901 paid then reversed is not paid).
      SELECT employee_id, code FROM items WHERE code IS NOT NULL AND code <> ''
       GROUP BY employee_id, code HAVING ROUND(SUM(amount), 2) <> 0
    ), non_cash_by_code AS (
      -- Floored per code, as payrollNonCashFiling.listRunNonCashBenefits (the certificate's reader): a code at or below nil is left out.
      SELECT employee_id, ROUND(SUM(amount), 2) AS amount FROM items WHERE non_cash GROUP BY employee_id, code
    ), totals AS (
      SELECT employee_id, SUM(gross_pay) AS gross, SUM(paye) AS paye,
             SUM(uif_employee + uif_employer) AS uif, SUM(sdl) AS sdl
        FROM lines GROUP BY employee_id
    )
    SELECT t.employee_id::text AS employee_id, pe.employee_number, pe.first_name, pe.last_name, pe.tax_number, pe.id_number,
           t.gross, t.paye, t.uif, t.sdl,
           COALESCE((SELECT SUM(n.amount) FROM non_cash_by_code n WHERE n.employee_id = t.employee_id AND n.amount > 0), 0) AS non_cash,
           COALESCE((SELECT SUM(i.amount) FROM items i
                      WHERE i.employee_id = t.employee_id AND i.code = '3801' AND NOT i.non_cash), 0) AS unflagged_3801,
           COALESCE((SELECT array_agg(c.code ORDER BY c.code) FROM code_net c WHERE c.employee_id = t.employee_id), '{}') AS codes
      FROM totals t
      JOIN payroll_employees pe ON pe.id = t.employee_id AND pe.company_id = ${companyId}::uuid
     ORDER BY pe.last_name, pe.first_name, pe.employee_number
  `) as PreValidationRow[];
}

/** Employees (of those given) with an approved severance directive covering the tax year. */
export async function loadSeveranceDirectives(companyId: string, taxYear: number, employeeIds: string[]): Promise<Set<string>> {
  if (employeeIds.length === 0) return new Set();
  const bounds = payeTaxYearBounds(taxYear);
  const rows = (await sql`
    SELECT DISTINCT employee_id::text AS employee_id FROM tax_directives
     WHERE company_id = ${companyId}::uuid AND directive_type = 'severance' AND status = 'approved'
       AND employee_id = ANY(${employeeIds}::uuid[])
       AND effective_date <= ${bounds.end}::date AND (expiry_date IS NULL OR expiry_date >= ${bounds.start}::date)
  `) as Array<{ employee_id: string }>;
  return new Set(rows.map((r) => r.employee_id));
}
