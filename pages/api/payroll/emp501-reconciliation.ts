/**
 * EMP501 Reconciliation API
 * GET /api/payroll/emp501-reconciliation?taxYear=2026
 * Compares sum of monthly EMP201 totals against aggregate IRP5 totals.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

interface MonthlyTotal {
  month: string;
  paye: number;
  uifEmployee: number;
  uifEmployer: number;
  sdl: number;
  eti: number;
}

interface Emp501Reconciliation {
  taxYear: number;
  monthly: MonthlyTotal[];
  emp201Totals: { paye: number; uifEmployee: number; uifEmployer: number; sdl: number; eti: number };
  irp5Totals: { paye: number; uifEmployee: number; uifEmployer: number };
  differences: { paye: number; uifEmployee: number; uifEmployer: number };
  isReconciled: boolean;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const taxYear = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
  if (!Number.isInteger(taxYear) || taxYear < 2020 || taxYear > 2100) {
    return apiResponse.badRequest(res, 'Invalid taxYear');
  }

  const start = `${taxYear - 1}-03-01`;
  const end = `${taxYear}-02-28`;
  const { companyId } = req;

  try {
    const monthlyRows = (await sql`
      SELECT
        TO_CHAR(pr.period_end, 'YYYY-MM') AS month,
        COALESCE(SUM(pr.total_paye), 0)::NUMERIC          AS paye,
        COALESCE(SUM(pr.total_uif_employee), 0)::NUMERIC  AS uif_employee,
        COALESCE(SUM(pr.total_uif_employer), 0)::NUMERIC  AS uif_employer,
        COALESCE(SUM(pr.total_sdl), 0)::NUMERIC           AS sdl,
        COALESCE(SUM(pr.total_eti), 0)::NUMERIC           AS eti
      FROM payroll_runs pr
      WHERE pr.company_id = ${companyId}::UUID
        AND pr.status = 'completed'
        AND pr.period_end >= ${start}::DATE
        AND pr.period_end <= ${end}::DATE
      GROUP BY TO_CHAR(pr.period_end, 'YYYY-MM')
      ORDER BY 1
    `) as Row[];

    const monthly: MonthlyTotal[] = monthlyRows.map((r) => ({
      month: String(r.month),
      paye: round2(Number(r.paye)),
      uifEmployee: round2(Number(r.uif_employee)),
      uifEmployer: round2(Number(r.uif_employer)),
      sdl: round2(Number(r.sdl)),
      eti: round2(Number(r.eti)),
    }));

    const emp201Totals = monthly.reduce(
      (acc, m) => ({
        paye: round2(acc.paye + m.paye),
        uifEmployee: round2(acc.uifEmployee + m.uifEmployee),
        uifEmployer: round2(acc.uifEmployer + m.uifEmployer),
        sdl: round2(acc.sdl + m.sdl),
        eti: round2(acc.eti + m.eti),
      }),
      { paye: 0, uifEmployee: 0, uifEmployer: 0, sdl: 0, eti: 0 }
    );

    const irp5Rows = (await sql`
      SELECT
        COALESCE(SUM(ps.paye), 0)::NUMERIC          AS paye,
        COALESCE(SUM(ps.uif_employee), 0)::NUMERIC  AS uif_employee,
        COALESCE(SUM(ps.uif_employer), 0)::NUMERIC  AS uif_employer
      FROM payslips ps
      JOIN payroll_runs pr ON pr.id = ps.payroll_run_id
      WHERE pr.company_id = ${companyId}::UUID
        AND pr.status = 'completed'
        AND pr.period_end >= ${start}::DATE
        AND pr.period_end <= ${end}::DATE
    `) as Row[];

    const irp5Totals = {
      paye: round2(Number(irp5Rows[0]?.paye) || 0),
      uifEmployee: round2(Number(irp5Rows[0]?.uif_employee) || 0),
      uifEmployer: round2(Number(irp5Rows[0]?.uif_employer) || 0),
    };

    const differences = {
      paye: round2(emp201Totals.paye - irp5Totals.paye),
      uifEmployee: round2(emp201Totals.uifEmployee - irp5Totals.uifEmployee),
      uifEmployer: round2(emp201Totals.uifEmployer - irp5Totals.uifEmployer),
    };

    const isReconciled =
      Math.abs(differences.paye) < 0.01 &&
      Math.abs(differences.uifEmployee) < 0.01 &&
      Math.abs(differences.uifEmployer) < 0.01;

    const data: Emp501Reconciliation = {
      taxYear, monthly, emp201Totals, irp5Totals, differences, isReconciled,
    };

    return apiResponse.success(res, data);
  } catch (err) {
    log.error('emp501 reconciliation failed', { error: err }, 'payroll-api');
    return apiResponse.internalError(res, err, 'Failed to compute EMP501 reconciliation');
  }
}

export default withAuth(withErrorHandler(handler));
