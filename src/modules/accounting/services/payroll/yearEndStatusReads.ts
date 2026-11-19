/**
 * The rows GET /api/payroll/year-end/status reads (moved out of the route): the company profile, the employees, the tax
 * year's per-employee sums, months and EMP201 PAYE, the components and the severance directives. The EMP201 PAYE is now
 * summed per month over every run of the month (payrollEmp201Paye, wave 6 FQb1); everything else is as it was.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  PAYE_TAX_YEAR_END_MONTH,
  PAYE_TAX_YEAR_START_MONTH,
  payeTaxYearBounds,
} from '@/modules/accounting/utils/payeTaxYear';
import { payRunFinalSql } from './payRunFinalSql';
import { emp201PayeByMonth } from './payrollEmp201Paye';
import { pspLineFlag } from './payrollOutsideTables';
import { listPspFilingTotals } from './pspFiling';

export async function readYearEndStatusRows(companyId: string, taxYear: number) {
  const startMonth = PAYE_TAX_YEAR_START_MONTH, startYear = taxYear - 1, endMonth = PAYE_TAX_YEAR_END_MONTH, endYear = taxYear;
  const bounds = payeTaxYearBounds(taxYear);
  // The checklist reports on the runs the IRP5 and EMP501 actually declare: FINAL runs (payRunFinalSql, wave 6 EF).

  const [companyRows, empRows, aggRows, monthRows, emp201ByMonth, componentRows, empCompRows, directiveRows, pspTotals] =
    await Promise.all([
      sql`
        SELECT
          paye_reference_number, sdl_reference_number, uif_reference_number, sic7_code,
          sars_contact_first_name, sars_contact_last_name,
          sars_contact_telephone, sars_contact_number,
          physical_address_line1, physical_postal_code,
          lockdown_enabled, lockdown_date
        FROM companies
        WHERE id = ${companyId}::uuid
      ` as Promise<DbRow[]>,
      sql`
        SELECT id, id_number, tax_number
        FROM   payroll_employees
        WHERE  company_id = ${companyId}::uuid
      ` as Promise<DbRow[]>,
      sql`
        SELECT
          prl.employee_id,
          SUM(prl.gross_pay)                       AS total_gross,
          SUM(prl.paye)                            AS total_paye,
          SUM(prl.uif_employee + prl.uif_employer) AS total_uif,
          SUM(prl.sdl)                             AS total_sdl
        FROM payroll_run_lines prl
        JOIN payroll_run_headers prh ON prh.id = prl.run_id
        WHERE prh.company_id = ${companyId}::uuid
          AND ${sql.unsafe(payRunFinalSql('prh'))}
          -- A personal service provider's line is on no natural-person certificate (pspFiling, wave 6 PSP): decided per line.
          AND NOT COALESCE(prl.validation_results @> ${pspLineFlag}::jsonb, false)
          AND (
            (prh.period_year = ${startYear} AND prh.period_month >= ${startMonth})
            OR
            (prh.period_year = ${endYear}   AND prh.period_month <= ${endMonth})
          )
        GROUP BY prl.employee_id
      ` as Promise<DbRow[]>,
      sql`
        SELECT DISTINCT period_year, period_month
        FROM   payroll_run_headers
        WHERE  company_id = ${companyId}::uuid
          AND  ${sql.unsafe(payRunFinalSql('payroll_run_headers'))}
          AND  (
            (period_year = ${startYear} AND period_month >= ${startMonth})
            OR
            (period_year = ${endYear}   AND period_month <= ${endMonth})
          )
      ` as Promise<DbRow[]>,
      emp201PayeByMonth(companyId, taxYear),
      sql`
        SELECT id, name, sars_source_code, component_type, is_active
        FROM   payroll_components
        WHERE  company_id = ${companyId}::uuid
      ` as Promise<DbRow[]>,
      sql`
        SELECT DISTINCT pec.employee_id, pc.sars_source_code
        FROM   payroll_employee_components pec
        JOIN   payroll_components pc ON pc.id = pec.component_id
        JOIN   payroll_employees  pe ON pe.id = pec.employee_id
        WHERE  pe.company_id = ${companyId}::uuid
          AND  pc.is_active = TRUE
      ` as Promise<DbRow[]>,

      sql`
        SELECT DISTINCT employee_id
        FROM   tax_directives
        WHERE  company_id     = ${companyId}::uuid
          AND  directive_type = 'severance'
          AND  status         = 'approved'
          AND  effective_date <= ${bounds.end}::date
          AND  (expiry_date IS NULL OR expiry_date >= ${bounds.start}::date)
      ` as Promise<DbRow[]>,
      listPspFilingTotals(companyId, bounds),
    ]);
  return { bounds, companyRows, empRows, aggRows, monthRows, emp201ByMonth, componentRows, empCompRows, directiveRows, pspTotals };
}
