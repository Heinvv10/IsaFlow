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
 *   6. Period lockdown applied (last day of February or later)
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { notFinalRunWarnings } from '@/modules/accounting/services/payroll/payRunNotFinal';
import { fmtDate } from '@/lib/fmtDate';
import type { DbRow } from '@/lib/neon';
import { readYearEndStatusRows } from '@/modules/accounting/services/payroll/yearEndStatusReads';
import { pspAggregateWarning, pspFilingWarning } from '@/modules/accounting/services/payroll/pspFiling';
import { canWrite } from '@/lib/auth/writeRoles';
import {
  validateCompanyComponents,
  validateEmployeeIrp5,
  type ComponentConfig,
} from '@/modules/accounting/services/payroll/irp5ValidationEngine';
import { countSeverity, type YearEndStatus } from '@/modules/accounting/services/payroll/yearEndStatusTypes';

export type { YearEndStatus } from '@/modules/accounting/services/payroll/yearEndStatusTypes';

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  // Pentest M17: bound numeric query params — reject year 9999 / -1 / NaN.
  const taxYearRaw = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYearRaw) || taxYearRaw < 2000 || taxYearRaw > 2100) {
    return apiResponse.badRequest(res, 'taxYear must be an integer between 2000 and 2100');
  }
  const taxYear = taxYearRaw;
  const { bounds, companyRows, empRows, aggRows, monthRows, emp201ByMonth, componentRows, empCompRows, directiveRows, pspTotals } =
    await readYearEndStatusRows(companyId, taxYear);

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
  const componentIssues = await validateCompanyComponents(components, taxYear);

  let readinessErrors = 0;
  let readinessWarnings = 0;
  let certificatesReady = 0;
  let empWithPayroll = 0;

  // Paid only as a PSP this year: no natural-person certificate to ready, so not validated or counted (wave 6 PSP).
  const pspOnly = new Set(pspTotals.filter((t) => !t.alsoEmployee).map((t) => t.employeeId));
  for (const emp of empRows) {
    if (pspOnly.has(String(emp.id))) continue;
    const agg = aggMap.get(String(emp.id));
    const totalGross = agg ? Number(agg.total_gross) : 0;
    if (totalGross > 0) empWithPayroll += 1;

    const msgs = await validateEmployeeIrp5({
      taxNumber: emp.tax_number ? String(emp.tax_number) : null,
      idNumber: emp.id_number ? String(emp.id_number) : null,
      totalGross,
      totalPaye: agg ? Number(agg.total_paye) : 0,
      totalUif: agg ? Number(agg.total_uif) : 0,
      totalSdl: agg ? Number(agg.total_sdl) : 0,
      componentCodes: codesByEmployee.get(String(emp.id)) ?? [],
      hasApprovedSeveranceDirective: employeesWithSeveranceDirective.has(String(emp.id)),
    }, taxYear);
    readinessErrors += countSeverity(msgs, 'error');
    readinessWarnings += countSeverity(msgs, 'warning');
    if (totalGross > 0 && countSeverity(msgs, 'error') === 0 && countSeverity(msgs, 'warning') === 0) {
      certificatesReady += 1;
    }
  }

  // ─── 5. EMP501 balanced ────────────────────────────────────────────────────

  const lineMap = new Map<string, number>();
  for (const emp of empRows) {
    const eid = String(emp.id);
    const row = aggMap.get(eid);
    if (row) {
      // collapse to yearly total via key 'total'
      lineMap.set(eid, Number(row.total_paye));
    }
  }

  const totalEmp201 = Array.from(emp201ByMonth.values()).reduce((s, v) => s + v, 0);
  const totalIrp5 = empRows.reduce((s, emp) => {
    const agg = aggMap.get(String(emp.id));
    return s + (agg ? Number(agg.total_paye) : 0);
  }, 0);
  const totalVariance = totalEmp201 - totalIrp5;
  const pspPaye = Math.round(pspTotals.reduce((s, t) => s + t.paye, 0) * 100) / 100;

  // ─── 6. Period lock ────────────────────────────────────────────────────────
  const lockDate = company.lockdown_date ? fmtDate(company.lockdown_date) : null;
  const lockedAtYearEnd = Boolean(
    company.lockdown_enabled && lockDate && lockDate >= bounds.end,
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
      pspPaye,
      unexplainedVariance: Math.round((totalVariance - pspPaye) * 100) / 100,
    },
    periodLock: { locked: lockedAtYearEnd, lockdownDate: lockDate },
    runWarnings: [
      ...await notFinalRunWarnings(companyId, bounds, 'year-end check'),
      // PSP PAYE, by name only for payroll-detail roles (this route is aggregate-only for a viewer, d3-employee-personal-data).
      ...(canWrite(companyRole) ? pspTotals.map((t) => pspFilingWarning(t, 'IRP5 certificates'))
        : [pspAggregateWarning(pspTotals, 'IRP5 certificates')].filter((w): w is string => w !== null)),
    ],
  };

  return apiResponse.success(res, payload);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
