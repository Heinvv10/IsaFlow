/**
 * GET /api/payroll/year-end/status?taxYear=YYYY
 *
 * Aggregates live status from existing payroll services so the year-end
 * workflow page can show a running checklist without the user opening
 * every screen individually.
 *
 * Steps surfaced:
 *   1. Company tax registration profile complete
 *   2. Employees registered
 *   3. Payroll runs posted for the year
 *   4. IRP5 readiness (no validation errors)
 *   5. EMP501 balanced (Σ EMP201 PAYE = Σ IRP5 PAYE)
 *   6. Period lockdown applied (Feb 28 or later)
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  validateCompanyComponents,
  validateEmployeeIrp5,
  type ComponentConfig,
  type ValidationMessage,
} from '@/modules/accounting/services/payroll/irp5ValidationEngine';

export interface YearEndStatus {
  taxYear: number;
  companyProfile: {
    complete: boolean;
    missing: string[];
  };
  employees: {
    total: number;
    withPayroll: number;
  };
  payrollRuns: {
    monthsCovered: number; // count of months in the tax year with at least one run
    totalPaye: number;
  };
  readiness: {
    errors: number;
    warnings: number;
    componentIssues: number;
    certificatesReady: number;
  };
  emp501: {
    balanced: boolean;
    totalEmp201: number;
    totalIrp5: number;
    totalVariance: number;
  };
  periodLock: {
    locked: boolean;
    lockdownDate: string | null;
  };
}

function countSeverity(msgs: ValidationMessage[], severity: 'error' | 'warning'): number {
  return msgs.filter((m) => m.severity === severity).length;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  const taxYear = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  const startMonth = 3, startYear = taxYear - 1, endMonth = 2, endYear = taxYear;

  const [companyRows, empRows, aggRows, monthRows, headerRows, componentRows, empCompRows, directiveRows] =
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
          AND prh.status IN ('approved', 'posted', 'calculated')
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
          AND  status IN ('approved', 'posted', 'calculated')
          AND  (
            (period_year = ${startYear} AND period_month >= ${startMonth})
            OR
            (period_year = ${endYear}   AND period_month <= ${endMonth})
          )
      ` as Promise<DbRow[]>,
      sql`
        SELECT period_month, period_year, COALESCE(total_paye, 0) AS emp201_paye
        FROM   payroll_run_headers
        WHERE  company_id = ${companyId}::uuid
          AND  status IN ('approved', 'posted', 'calculated')
          AND (
            (period_year = ${startYear} AND period_month >= ${startMonth})
            OR
            (period_year = ${endYear}   AND period_month <= ${endMonth})
          )
      ` as Promise<DbRow[]>,
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
          AND  effective_date <= ${`${endYear}-02-28`}::date
          AND  (expiry_date IS NULL OR expiry_date >= ${`${startYear}-03-01`}::date)
      ` as Promise<DbRow[]>,
    ]);

  const employeesWithSeveranceDirective = new Set(
    directiveRows.map((r) => String(r.employee_id)),
  );

  const company = companyRows[0];
  if (!company) {
    return apiResponse.notFound(res, 'Company');
  }

  // ─── 1. Company profile ────────────────────────────────────────────────────
  const missing: string[] = [];
  if (!company.paye_reference_number) missing.push('PAYE reference number');
  if (!company.sars_contact_first_name) missing.push('SARS contact first name');
  if (!company.sars_contact_last_name) missing.push('SARS contact surname');
  if (!company.physical_address_line1) missing.push('Physical address line 1');
  if (!company.physical_postal_code) missing.push('Physical postal code');
  if (!(company.sars_contact_telephone || company.sars_contact_number)) {
    missing.push('SARS contact telephone or cell number');
  }

  // ─── 4. IRP5 readiness (aggregate messages across all employees) ──────────
  const aggMap = new Map<string, DbRow>();
  aggRows.forEach((r) => aggMap.set(String(r.employee_id), r));

  const codesByEmployee = new Map<string, string[]>();
  for (const r of empCompRows) {
    const eid = String(r.employee_id);
    const list = codesByEmployee.get(eid) ?? [];
    list.push(String(r.sars_source_code));
    codesByEmployee.set(eid, list);
  }

  const components: ComponentConfig[] = componentRows.map((r) => ({
    id: String(r.id),
    name: String(r.name),
    sarsSourceCode: String(r.sars_source_code),
    componentType: String(r.component_type) as ComponentConfig['componentType'],
    isActive: Boolean(r.is_active),
  }));
  const componentIssues = validateCompanyComponents(components);

  let readinessErrors = 0;
  let readinessWarnings = 0;
  let certificatesReady = 0;
  let empWithPayroll = 0;

  for (const emp of empRows) {
    const agg = aggMap.get(String(emp.id));
    const totalGross = agg ? Number(agg.total_gross) : 0;
    if (totalGross > 0) empWithPayroll += 1;

    const msgs = validateEmployeeIrp5({
      taxNumber: emp.tax_number ? String(emp.tax_number) : null,
      idNumber: emp.id_number ? String(emp.id_number) : null,
      totalGross,
      totalPaye: agg ? Number(agg.total_paye) : 0,
      totalUif: agg ? Number(agg.total_uif) : 0,
      totalSdl: agg ? Number(agg.total_sdl) : 0,
      componentCodes: codesByEmployee.get(String(emp.id)) ?? [],
      hasApprovedSeveranceDirective: employeesWithSeveranceDirective.has(String(emp.id)),
    });
    readinessErrors += countSeverity(msgs, 'error');
    readinessWarnings += countSeverity(msgs, 'warning');
    if (totalGross > 0 && countSeverity(msgs, 'error') === 0 && countSeverity(msgs, 'warning') === 0) {
      certificatesReady += 1;
    }
  }

  // ─── 5. EMP501 balanced ────────────────────────────────────────────────────
  const headerMap = new Map<string, number>();
  headerRows.forEach((r) => headerMap.set(`${r.period_year}-${r.period_month}`, Number(r.emp201_paye)));

  const lineMap = new Map<string, number>();
  for (const emp of empRows) {
    const eid = String(emp.id);
    const row = aggMap.get(eid);
    if (row) {
      // collapse to yearly total via key 'total'
      lineMap.set(eid, Number(row.total_paye));
    }
  }

  const totalEmp201 = Array.from(headerMap.values()).reduce((s, v) => s + v, 0);
  const totalIrp5 = empRows.reduce((s, emp) => {
    const agg = aggMap.get(String(emp.id));
    return s + (agg ? Number(agg.total_paye) : 0);
  }, 0);
  const totalVariance = totalEmp201 - totalIrp5;

  // ─── 6. Period lock ────────────────────────────────────────────────────────
  const lockDate = company.lockdown_date instanceof Date
    ? company.lockdown_date.toISOString().slice(0, 10)
    : (company.lockdown_date ? String(company.lockdown_date) : null);
  const lockedAtYearEnd = Boolean(
    company.lockdown_enabled && lockDate && new Date(lockDate) >= new Date(`${endYear}-02-28`),
  );

  const payload: YearEndStatus = {
    taxYear,
    companyProfile: { complete: missing.length === 0, missing },
    employees: { total: empRows.length, withPayroll: empWithPayroll },
    payrollRuns: {
      monthsCovered: monthRows.length,
      totalPaye: totalIrp5,
    },
    readiness: {
      errors: readinessErrors,
      warnings: readinessWarnings,
      componentIssues: componentIssues.length,
      certificatesReady,
    },
    emp501: {
      balanced: Math.abs(totalVariance) < 0.01 && totalEmp201 > 0,
      totalEmp201,
      totalIrp5,
      totalVariance,
    },
    periodLock: { locked: lockedAtYearEnd, lockdownDate: lockDate },
  };

  return apiResponse.success(res, payload);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
