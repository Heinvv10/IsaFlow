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
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';

type Row = DbRow;

const MONTH_LABELS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface ReconciliationRow {
  month: number;
  monthLabel: string;
  year: number;
  emp201Paye: number;
  irp5Paye: number;
  variance: number;
  status: 'balanced' | 'variance' | 'no_data';
}

export interface Emp501Summary {
  taxYear: number;
  rows: ReconciliationRow[];
  totalEmp201: number;
  totalIrp5: number;
  totalVariance: number;
}

function taxYearMonths(taxYear: number): Array<{ month: number; year: number }> {
  // Mar (taxYear-1) to Feb (taxYear)
  const result: Array<{ month: number; year: number }> = [];
  for (let m = 3; m <= 12; m++) result.push({ month: m, year: taxYear - 1 });
  for (let m = 1; m <= 2; m++) result.push({ month: m, year: taxYear });
  return result;
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
  // Same status set as the EMP201 report and the IRP5/EMP501 exports this
  // reconciles — 'posted' is not an admissible status and 'calculated' has no
  // journal in the general ledger.
  const declarableStatuses: string[] = [...EMP201_DECLARABLE_STATUSES];

  // EMP201 declared PAYE per period from run headers
  const headerRows = (await sql`
    SELECT
      period_month,
      period_year,
      COALESCE(total_paye, 0) AS emp201_paye
    FROM payroll_run_headers
    WHERE company_id = ${companyId}::uuid
      AND status = ANY(${declarableStatuses}::text[])
      AND (
        (period_year = ${taxYear - 1} AND period_month >= 3)
        OR
        (period_year = ${taxYear} AND period_month <= 2)
      )
    ORDER BY period_year, period_month
  `) as Row[];

  // IRP5 PAYE per period from run lines (more accurate)
  const lineRows = (await sql`
    SELECT
      prh.period_month,
      prh.period_year,
      SUM(prl.paye) AS irp5_paye
    FROM payroll_run_lines prl
    JOIN payroll_run_headers prh ON prh.id = prl.run_id
    WHERE prh.company_id = ${companyId}::uuid
      AND prh.status = ANY(${declarableStatuses}::text[])
      AND (
        (prh.period_year = ${taxYear - 1} AND prh.period_month >= 3)
        OR
        (prh.period_year = ${taxYear} AND prh.period_month <= 2)
      )
    GROUP BY prh.period_month, prh.period_year
  `) as Row[];

  const headerMap = new Map<string, number>();
  headerRows.forEach(r => headerMap.set(`${r.period_year}-${r.period_month}`, Number(r.emp201_paye)));

  const lineMap = new Map<string, number>();
  lineRows.forEach(r => lineMap.set(`${r.period_year}-${r.period_month}`, Number(r.irp5_paye)));

  const months = taxYearMonths(taxYear);
  const rows: ReconciliationRow[] = months.map(({ month, year }) => {
    const key = `${year}-${month}`;
    const emp201 = headerMap.get(key) ?? 0;
    const irp5 = lineMap.get(key) ?? 0;
    const variance = emp201 - irp5;
    const hasData = headerMap.has(key) || lineMap.has(key);
    return {
      month,
      monthLabel: `${MONTH_LABELS[month]} ${year}`,
      year,
      emp201Paye: emp201,
      irp5Paye: irp5,
      variance,
      status: hasData ? (Math.abs(variance) < 0.01 ? 'balanced' : 'variance') : 'no_data',
    };
  });

  const summary: Emp501Summary = {
    taxYear,
    rows,
    totalEmp201: rows.reduce((s, r) => s + r.emp201Paye, 0),
    totalIrp5: rows.reduce((s, r) => s + r.irp5Paye, 0),
    totalVariance: rows.reduce((s, r) => s + r.variance, 0),
  };

  return apiResponse.success(res, summary);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
