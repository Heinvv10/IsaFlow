/**
 * GET /api/payroll/emp501/reconciliation?taxYear=2025
 *
 * Returns month-by-month EMP201 vs IRP5 PAYE reconciliation for the tax year.
 * EMP201 PAYE = sum of paye from payroll_run_headers (declared).
 * IRP5 PAYE  = sum of paye from payroll_run_lines (calculated per employee).
 */
import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { payRunFinalSql } from '@/modules/accounting/services/payroll/payRunFinalSql';
import { notFinalRunWarnings } from '@/modules/accounting/services/payroll/payRunNotFinal';
import { PAYE_TAX_YEAR_END_MONTH, PAYE_TAX_YEAR_START_MONTH, payeTaxYearBounds } from '@/modules/accounting/utils/payeTaxYear';
import { emp201PayeByMonth } from '@/modules/accounting/services/payroll/payrollEmp201Paye';
import { pspLineFlag } from '@/modules/accounting/services/payroll/payrollOutsideTables';
import { listPspFilingTotals, pspAggregateWarning, pspFilingWarning } from '@/modules/accounting/services/payroll/pspFiling';
import { canWrite } from '@/lib/auth/writeRoles';

type Row = DbRow;

const MONTH_LABELS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ReconciliationRow {
  month: number;
  monthLabel: string;
  year: number;
  emp201Paye: number;
  irp5Paye: number;
  variance: number;
  /**
   * PAYE on personal service provider lines (wave 6 PSP): declared on the EMP201, on no natural-person certificate; part of
   * the variance. Payroll-detail roles only (withPayrollDetailAccess's set): absent for a viewer.
   */
  pspPaye?: number;
  /** variance - pspPaye: what no PSP explains (payroll-detail roles only, as pspPaye). */
  unexplainedVariance?: number;
  /** explained_psp: the month's whole variance is PSP PAYE (payroll-detail roles only; a viewer sees 'variance'). */
  status: 'balanced' | 'explained_psp' | 'variance' | 'no_data';
}

export interface Emp501Summary {
  taxYear: number;
  rows: ReconciliationRow[];
  totalEmp201: number;
  totalIrp5: number;
  totalVariance: number;
  /** All PSP PAYE in the year, and the variance it does not explain: aggregate figures, for every role (review H). */
  totalPspPaye: number;
  totalUnexplainedVariance: number;
  /** Approved/paid runs left out because they are not final (wave 6 EF), by name. */
  runWarnings: string[];
}

function taxYearMonths(taxYear: number): Array<{ month: number; year: number }> {
  // The tax year's first month (taxYear-1) to its last (taxYear)
  const result: Array<{ month: number; year: number }> = [];
  for (let m = PAYE_TAX_YEAR_START_MONTH; m <= 12; m++) result.push({ month: m, year: taxYear - 1 });
  for (let m = 1; m <= PAYE_TAX_YEAR_END_MONTH; m++) result.push({ month: m, year: taxYear });
  return result;
}

async function handler(req: AuthenticatedNextApiRequest, res: NextApiResponse): Promise<void> {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const detail = canWrite(companyRole); // payroll-detail access (withPayrollDetailAccess's set): names PSPs and their PAYE
  // Pentest M17: bound numeric query params — reject year 9999 / -1 / NaN.
  const taxYearRaw = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYearRaw) || taxYearRaw < 2000 || taxYearRaw > 2100) {
    return apiResponse.badRequest(res, 'taxYear must be an integer between 2000 and 2100');
  }
  const taxYear = taxYearRaw;
  // The same runs as the EMP201 report and the IRP5/EMP501 exports this reconciles: FINAL runs only
  // (payRunFinalSql: approved or paid with an approval time; wave 6 EF). One left out is named in runWarnings.

  // EMP201 declared PAYE per period from run headers
  const headerMap = await emp201PayeByMonth(companyId, taxYear);

  // IRP5 PAYE per period from run lines (more accurate)
  const lineRows = (await sql`
    SELECT
      prh.period_month,
      prh.period_year,
      -- A personal service provider's line is on no natural-person certificate (pspFiling, wave 6 PSP): its PAYE is apart.
      SUM(prl.paye) FILTER (WHERE NOT COALESCE(prl.validation_results @> ${pspLineFlag}::jsonb, false)) AS irp5_paye,
      COALESCE(SUM(prl.paye) FILTER (WHERE prl.validation_results @> ${pspLineFlag}::jsonb), 0) AS psp_paye
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    WHERE prh.company_id = ${companyId}::uuid
      AND ${sql.unsafe(payRunFinalSql('prh'))}
      AND (
        (prh.period_year = ${taxYear - 1} AND prh.period_month >= ${PAYE_TAX_YEAR_START_MONTH})
        OR
        (prh.period_year = ${taxYear} AND prh.period_month <= ${PAYE_TAX_YEAR_END_MONTH})
      )
    GROUP BY prh.period_month, prh.period_year
  `) as Row[];


  const lineMap = new Map<string, number>();
  lineRows.forEach(r => lineMap.set(`${r.period_year}-${r.period_month}`, Number(r.irp5_paye ?? 0)));
  const pspMap = new Map(lineRows.map(r => [`${r.period_year}-${r.period_month}`, Number(r.psp_paye)]));

  const psp = await listPspFilingTotals(companyId, payeTaxYearBounds(taxYear));
  const months = taxYearMonths(taxYear);
  const rows: ReconciliationRow[] = months.map(({ month, year }) => {
    const key = `${year}-${month}`;
    const emp201 = headerMap.get(key) ?? 0;
    const irp5 = lineMap.get(key) ?? 0;
    const variance = emp201 - irp5;
    const hasData = headerMap.has(key) || lineMap.has(key);
    const pspPaye = pspMap.get(key) ?? 0;
    const unexplained = Math.round((variance - pspPaye) * 100) / 100;
    const explained = Math.abs(variance) >= 0.01 && Math.abs(unexplained) < 0.01;
    return {
      month,
      monthLabel: `${MONTH_LABELS[month]} ${year}`,
      year,
      emp201Paye: emp201,
      irp5Paye: irp5,
      variance,
      ...(detail ? { pspPaye, unexplainedVariance: unexplained } : {}),
      status: !hasData ? 'no_data' : Math.abs(variance) < 0.01 ? 'balanced' : detail && explained ? 'explained_psp' : 'variance',
    };
  });

  const summary: Emp501Summary = {
    taxYear,
    rows,
    totalEmp201: rows.reduce((s, r) => s + r.emp201Paye, 0),
    totalIrp5: rows.reduce((s, r) => s + r.irp5Paye, 0),
    totalVariance: rows.reduce((s, r) => s + r.variance, 0),
    totalPspPaye: Math.round([...pspMap.values()].reduce((s, v) => s + v, 0) * 100) / 100,
    totalUnexplainedVariance: Math.round((rows.reduce((s, r) => s + r.variance, 0) - [...pspMap.values()].reduce((s, v) => s + v, 0)) * 100) / 100,
    runWarnings: [
      ...await notFinalRunWarnings(companyId, payeTaxYearBounds(taxYear), 'EMP501 reconciliation'),
      // The PAYE difference a PSP's months leave, explained by name (pspFiling; UNVERIFIED until the PSP certificate is produced).
      // Named per person only for payroll-detail roles; a viewer (this route is aggregate-only for them) gets one total line.
      ...(detail ? psp.map((t) => pspFilingWarning(t, 'IRP5 side of this reconciliation'))
        : [pspAggregateWarning(psp, 'IRP5 side of this reconciliation')].filter((w): w is string => w !== null)),
    ],
  };

  return apiResponse.success(res, summary);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
