/**
 * IRP5 Certificates API
 * GET  /api/payroll/irp5-certificates?taxYear=2026  — aggregate per-employee IRP5 data
 * POST /api/payroll/irp5-certificates?action=generate — return computed IRP5 records
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface Irp5CertRow {
  employee_id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  id_number: string | null;
  tax_number: string | null;
  total_gross_income: number;
  total_paye: number;
  total_uif_employee: number;
  total_uif_employer: number;
  total_net_pay: number;
  certificate_number: string;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** SA tax year runs March → February. 2026 = Mar 2025 – Feb 2026. */
function taxYearRange(yr: number): { start: string; end: string } {
  return {
    start: `${yr - 1}-03-01`,
    end: `${yr}-02-28`,
  };
}

function buildCertNumber(companyId: string, employeeNumber: string, yr: number): string {
  const prefix = companyId.replace(/-/g, '').slice(0, 6).toUpperCase();
  const empRef = employeeNumber.replace(/\D/g, '').slice(-4).padStart(4, '0');
  return `IRP5-${yr}-${prefix}-${empRef}`;
}

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;

  // ── GET: aggregate IRP5 data for a tax year ──────────────────────────────────
  if (req.method === 'GET') {
    const taxYear = req.query.taxYear ? Number(req.query.taxYear) : new Date().getFullYear();
    const { start, end } = taxYearRange(taxYear);

    try {
      const rows = (await sql`
        SELECT
          e.id                                          AS employee_id,
          e.employee_number,
          e.first_name,
          e.last_name,
          e.id_number,
          e.tax_number,
          COALESCE(SUM(ps.gross_pay),    0)::NUMERIC    AS total_gross_income,
          COALESCE(SUM(ps.paye),         0)::NUMERIC    AS total_paye,
          COALESCE(SUM(ps.uif_employee), 0)::NUMERIC    AS total_uif_employee,
          COALESCE(SUM(ps.uif_employer), 0)::NUMERIC    AS total_uif_employer,
          COALESCE(SUM(ps.net_pay),      0)::NUMERIC    AS total_net_pay
        FROM employees e
        LEFT JOIN payslips ps ON ps.employee_id = e.id
        LEFT JOIN payroll_runs pr
          ON ps.payroll_run_id = pr.id
         AND pr.company_id     = ${companyId}::UUID
         AND pr.period_end    >= ${start}::DATE
         AND pr.period_end    <= ${end}::DATE
        WHERE e.company_id = ${companyId}::UUID
        GROUP BY e.id, e.employee_number, e.first_name, e.last_name, e.id_number, e.tax_number
        ORDER BY e.last_name, e.first_name
        LIMIT 500
      `) as Row[];

      const certs: Irp5CertRow[] = rows.map((r: Row) => ({
        employee_id:        String(r.employee_id),
        employee_number:    String(r.employee_number),
        first_name:         String(r.first_name),
        last_name:          String(r.last_name),
        id_number:          r.id_number ? String(r.id_number) : null,
        tax_number:         r.tax_number ? String(r.tax_number) : null,
        total_gross_income: round2(Number(r.total_gross_income)),
        total_paye:         round2(Number(r.total_paye)),
        total_uif_employee: round2(Number(r.total_uif_employee)),
        total_uif_employer: round2(Number(r.total_uif_employer)),
        total_net_pay:      round2(Number(r.total_net_pay)),
        certificate_number: buildCertNumber(companyId, String(r.employee_number), taxYear),
      }));

      log.info('IRP5 list fetched', { companyId, taxYear, count: certs.length }, 'irp5-api');
      return apiResponse.success(res, { taxYear, certificates: certs });
    } catch (err) {
      log.error('IRP5 GET failed', { error: err }, 'irp5-api');
      return apiResponse.internalError(res, err, 'Failed to fetch IRP5 data');
    }
  }

  // ── POST ?action=generate ─────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action } = req.query;
    if (action !== 'generate') {
      return apiResponse.badRequest(res, 'Invalid action — use ?action=generate');
    }

    const taxYear = req.body?.taxYear ? Number(req.body.taxYear) : new Date().getFullYear();
    const { start, end } = taxYearRange(taxYear);

    try {
      const rows = (await sql`
        SELECT
          e.id                                          AS employee_id,
          e.employee_number,
          e.first_name,
          e.last_name,
          e.id_number,
          e.tax_number,
          COALESCE(SUM(ps.gross_pay),    0)::NUMERIC    AS total_gross_income,
          COALESCE(SUM(ps.paye),         0)::NUMERIC    AS total_paye,
          COALESCE(SUM(ps.uif_employee), 0)::NUMERIC    AS total_uif_employee,
          COALESCE(SUM(ps.uif_employer), 0)::NUMERIC    AS total_uif_employer,
          COALESCE(SUM(ps.net_pay),      0)::NUMERIC    AS total_net_pay
        FROM employees e
        INNER JOIN payslips ps ON ps.employee_id = e.id
        INNER JOIN payroll_runs pr
          ON ps.payroll_run_id = pr.id
         AND pr.company_id     = ${companyId}::UUID
         AND pr.status         IN ('completed')
         AND pr.period_end    >= ${start}::DATE
         AND pr.period_end    <= ${end}::DATE
        WHERE e.company_id = ${companyId}::UUID
        GROUP BY e.id, e.employee_number, e.first_name, e.last_name, e.id_number, e.tax_number
        HAVING SUM(ps.gross_pay) > 0
        ORDER BY e.last_name, e.first_name
        LIMIT 500
      `) as Row[];

      const certs: Irp5CertRow[] = rows.map((r: Row) => ({
        employee_id:        String(r.employee_id),
        employee_number:    String(r.employee_number),
        first_name:         String(r.first_name),
        last_name:          String(r.last_name),
        id_number:          r.id_number ? String(r.id_number) : null,
        tax_number:         r.tax_number ? String(r.tax_number) : null,
        total_gross_income: round2(Number(r.total_gross_income)),
        total_paye:         round2(Number(r.total_paye)),
        total_uif_employee: round2(Number(r.total_uif_employee)),
        total_uif_employer: round2(Number(r.total_uif_employer)),
        total_net_pay:      round2(Number(r.total_net_pay)),
        certificate_number: buildCertNumber(companyId, String(r.employee_number), taxYear),
      }));

      log.info('IRP5 generated', { companyId, taxYear, count: certs.length }, 'irp5-api');
      return apiResponse.success(res, {
        taxYear,
        taxYearRange: { start, end },
        count: certs.length,
        certificates: certs,
      });
    } catch (err) {
      log.error('IRP5 generate failed', { error: err }, 'irp5-api');
      return apiResponse.internalError(res, err, 'Failed to generate IRP5 certificates');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
