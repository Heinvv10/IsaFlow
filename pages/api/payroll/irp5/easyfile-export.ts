/**
 * GET /api/payroll/irp5/easyfile-export?taxYear=2026
 *
 * Produces a SARS e@syFile IRP5 import file (.irp5 CSV text) per BRS v25.2.
 *
 * Tax year 2026 = Mar 2025 – Feb 2026. Emits an annual (reconciliation
 * period MM=02) certificate. Interim submissions (MM=08) are not yet
 * supported — the page only surfaces annual.
 *
 * Returns 422 with an explanation when the company is missing the
 * payroll-tax registration fields required by SARS.
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import {
  buildIrp5File,
  buildCertificateNumber,
  splitCertificateIncome,
  UsageError,
  type EmployerInput,
  type EmployeeInput,
} from '@/modules/accounting/services/payroll/easyFileExportService';
import { withPayrollDetailAccess } from '@/lib/auth/withPayrollDetailAccess';
import { saTaxYearBounds } from '@/modules/accounting/services/payroll/irp5DataService';
import { PAYE_TAX_YEAR_END_MONTH, PAYE_TAX_YEAR_START_MONTH } from '@/modules/accounting/utils/payeTaxYear';
import { issuedDateWarning, listRunAnnualPayments } from '@/modules/accounting/services/payroll/payrollLumpSumFiling';
import { listCertificateLumpSums } from '@/modules/accounting/services/payroll/directivePaymentFiling';
import { taxThresholdFor } from '@/modules/accounting/services/payroll/easyFileTaxThreshold';
import { capWarningsForHeader } from '@/modules/accounting/services/payroll/easyFileWarnings';

function firstTwoNames(fullFirst: string): string {
  return fullFirst.trim().split(/\s+/).slice(0, 2).join(' ');
}

function initialsFromName(fullFirst: string): string {
  return fullFirst
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase())
    .join('')
    .slice(0, 5);
}

function toCCYYMMDD(value: unknown): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

function monthsBetween(start: string, endInclusive: string): number {
  // Inputs are CCYYMMDD. Count full months the employee was active within
  // the year-of-assessment window, max 12.
  const s = new Date(`${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`);
  const e = new Date(`${endInclusive.slice(0, 4)}-${endInclusive.slice(4, 6)}-${endInclusive.slice(6, 8)}`);
  const months = (e.getUTCFullYear() - s.getUTCFullYear()) * 12 + (e.getUTCMonth() - s.getUTCMonth()) + 1;
  return Math.min(12, Math.max(0, months));
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId } = req as CompanyAuthedRequest;
  // Pentest M17: bound numeric query params — reject year 9999 / -1 / NaN.
  const taxYearRaw = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYearRaw) || taxYearRaw < 2000 || taxYearRaw > 2100) {
    return apiResponse.badRequest(res, 'taxYear must be an integer between 2000 and 2100');
  }
  const taxYear = taxYearRaw;
  const startMonth = PAYE_TAX_YEAR_START_MONTH, startYear = taxYear - 1, endMonth = PAYE_TAX_YEAR_END_MONTH, endYear = taxYear;
  // Only approved/paid runs exist in the general ledger; a calculated or
  // cancelled run declared here would over-state remuneration to SARS.
  const declarableStatuses: string[] = [...EMP201_DECLARABLE_STATUSES];

  // Lump sums paid under a directive, in a run or outside payroll (own code,
  // PAYE under 4115 or 4102 by code), and annual payments (3605): reported
  // apart, so taken out of 3601 below (audit 2026-10-18 P3; PAYE 4a
  // follow-ups G1). The stand-alone payments are in no run line, so their
  // gross and PAYE are added to the run totals.
  const bounds = saTaxYearBounds(taxYear);
  const [companyRows, empRows, aggRows, lumpSums, annualByEmployee] = await Promise.all([
    sql`
      SELECT
        COALESCE(registered_name, name) AS trading_name,
        paye_reference_number, sdl_reference_number, uif_reference_number, sic7_code,
        sars_contact_first_name, sars_contact_last_name,
        sars_contact_telephone, sars_contact_number,
        email,
        physical_address_line1, physical_city, physical_province, physical_postal_code
      FROM companies
      WHERE id = ${companyId}::uuid
    ` as Promise<DbRow[]>,
    sql`
      SELECT id, first_name, last_name, id_number, tax_number, start_date, end_date, date_of_birth
      FROM   payroll_employees
      WHERE  company_id = ${companyId}::uuid
      ORDER  BY last_name, first_name
    ` as Promise<DbRow[]>,
    sql`
      SELECT
        prl.employee_id,
        SUM(prl.gross_pay)    AS total_gross,
        SUM(prl.paye)         AS total_paye,
        SUM(prl.uif_employee) AS total_uif_emp,
        SUM(prl.uif_employer) AS total_uif_empr,
        SUM(prl.sdl)          AS total_sdl
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
      WHERE prh.company_id = ${companyId}::uuid
        AND prh.status = ANY(${declarableStatuses}::text[])
        AND (
          (prh.period_year = ${startYear} AND prh.period_month >= ${startMonth})
          OR
          (prh.period_year = ${endYear}   AND prh.period_month <= ${endMonth})
        )
      GROUP BY prl.employee_id
    ` as Promise<DbRow[]>,
    listCertificateLumpSums(companyId, bounds),
    listRunAnnualPayments(companyId, bounds),
  ]);

  const company = companyRows[0];
  if (!company) {
    return apiResponse.notFound(res, 'Company');
  }

  const missing: string[] = [];
  if (!company.paye_reference_number) missing.push('PAYE reference number');
  if (!company.sars_contact_first_name) missing.push('SARS contact first name');
  if (!company.sars_contact_last_name) missing.push('SARS contact surname');
  if (!company.physical_address_line1) missing.push('Physical address line 1');
  if (!company.physical_postal_code) missing.push('Physical postal code');
  if (!(company.sars_contact_telephone || company.sars_contact_number)) {
    missing.push('SARS contact telephone or cell number');
  }
  if (missing.length > 0) {
    return apiResponse.error(
      res,
      'VALIDATION_ERROR' as never,
      'Cannot generate e@syFile export — company profile is missing required fields',
      { missing, fix: 'Accounting → Settings → Company Details' },
    );
  }

  const payeRef = String(company.paye_reference_number).trim();
  const aggMap = new Map<string, DbRow>();
  aggRows.forEach((r) => aggMap.set(String(r.employee_id), r));

  const yoaStart = bounds.start.replaceAll('-', '');
  const yoaEndInclusive = bounds.end.replaceAll('-', ''); // last day of February, 29th in a leap year

  const employees: EmployeeInput[] = [];
  const warnings: string[] = [];
  let seq = 0;
  for (const row of empRows) {
    const standalone = lumpSums.standaloneTotals.get(String(row.id)) ?? { gross: 0, paye: 0 };
    const agg = aggMap.get(String(row.id)) ?? (standalone.gross > 0 ? ({} as DbRow) : undefined);
    if (!agg) continue;
    const gross = Number(agg.total_gross ?? 0) + standalone.gross;
    if (gross <= 0) continue; // skip non-active employees

    const employeeLumpSums = lumpSums.byEmployee.get(String(row.id)) ?? [];
    const split = splitCertificateIncome({
      gross, paye: Number(agg.total_paye ?? 0) + standalone.paye,
      annualPayments: annualByEmployee.get(String(row.id)) ?? 0, lumpSums: employeeLumpSums,
    });
    const who = `${String(row.first_name ?? '')} ${String(row.last_name ?? '')}`.trim();
    warnings.push(...employeeLumpSums.filter(l => l.issuedDateFallback).map(l => issuedDateWarning(who, l)));
    seq += 1;
    const certStartDate = toCCYYMMDD(row.start_date) ?? yoaStart;
    const certEndDate = toCCYYMMDD(row.end_date);
    const periodStart = certStartDate > yoaStart ? certStartDate : yoaStart;
    const periodEnd = certEndDate && certEndDate < yoaEndInclusive ? certEndDate : yoaEndInclusive;

    employees.push({
      certificateNumber: buildCertificateNumber(payeRef, taxYear, 2, seq),
      yearOfAssessment: taxYear,
      surname: String(row.last_name ?? ''),
      firstNames: firstTwoNames(String(row.first_name ?? '')),
      initials: initialsFromName(String(row.first_name ?? '')),
      idNumber: String(row.id_number ?? ''),
      taxNumber: row.tax_number ? String(row.tax_number) : null,
      employmentStartDate: certStartDate,
      employmentEndDate: certEndDate,
      periodsInYoA: monthsBetween(periodStart, periodEnd),
      ...split,
      lumpSums: employeeLumpSums.map(l => ({
        sourceCode: l.sourceCode,
        directiveNumber: l.directiveNumber ?? '',
        directiveIssuedDate: l.directiveIssuedDate.replace(/-/g, ''),
        amount: l.amount,
        paye: l.paye,
      })),
      taxThreshold: taxThresholdFor(taxYear, row.date_of_birth, row.id_number),
      uifEmployee: Number(agg.total_uif_emp ?? 0),
      uifEmployer: Number(agg.total_uif_empr ?? 0),
      sdl4142: Number(agg.total_sdl ?? 0),
    });
  }

  if (employees.length === 0) {
    return apiResponse.badRequest(res, 'No employees with payroll activity in the selected tax year');
  }

  const employer: EmployerInput = {
    tradingName: String(company.trading_name),
    payeReferenceNumber: payeRef,
    sdlReferenceNumber: company.sdl_reference_number ? String(company.sdl_reference_number) : null,
    uifReferenceNumber: company.uif_reference_number ? String(company.uif_reference_number) : null,
    contactFirstName: String(company.sars_contact_first_name),
    contactSurname: String(company.sars_contact_last_name),
    contactBusinessPhone: company.sars_contact_telephone ? String(company.sars_contact_telephone) : null,
    contactCellPhone: company.sars_contact_number ? String(company.sars_contact_number) : null,
    contactEmail: company.email ? String(company.email) : null,
    transactionYear: taxYear,
    reconciliationPeriod: Number(`${taxYear}02`),
    sic7Code: company.sic7_code ? String(company.sic7_code) : null,
    physicalStreet: String(company.physical_address_line1),
    physicalSuburb: company.physical_province ? String(company.physical_province) : null,
    physicalCity: company.physical_city ? String(company.physical_city) : null,
    physicalPostalCode: String(company.physical_postal_code),
  };

  try {
    const fileBody = buildIrp5File({ employer, employees });
    const filename = `IRP5_${taxYear - 1}_${taxYear}_${payeRef}.irp5`;

    log.info('e@syFile IRP5 export generated', {
      companyId, taxYear, employees: employees.length, bytes: fileBody.length,
    }, 'easyFileExport');
    // A directive with no issued date files its effective date as 3231, and a
    // payment under a directive linked to no employee is on no certificate
    // (applyTaxDirective now refuses those): both said, naming the directive,
    // and shown by the IRP5 page.
    // A payment on no certificate first: the cap below must never hide one.
    warnings.unshift(...lumpSums.unlinked.map(p => `SARS directive ${p.directiveNumber ?? p.directiveId} (${p.employeeName}), `
      + `paid outside payroll on ${p.paymentDate}, is linked to no employee, so it is on no certificate in this file.`));
    const warningsTotal = warnings.length;
    warnings.splice(0, warningsTotal, ...capWarningsForHeader(warnings));
    if (warnings.length > 0) {
      // Counts only in the log: the text names employees and is for the authorised caller.
      log.warn('e@syFile export warnings', {
        companyId, taxYear, warnings: warningsTotal, unlinkedPayments: lumpSums.unlinked.map(p => p.paymentId),
      }, 'easyFileExport');
      res.setHeader('X-IsaFlow-Warnings', encodeURIComponent(JSON.stringify(warnings)));
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).end(fileBody);
  } catch (err) {
    if (err instanceof UsageError) {
      return apiResponse.error(res, 'VALIDATION_ERROR' as never, err.message);
    }
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withPayrollDetailAccess(handler))));
