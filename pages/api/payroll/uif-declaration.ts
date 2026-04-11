/**
 * UIF Declaration API
 * GET  /api/payroll/uif-declaration?month=2026-04   — UIF data for the month
 * POST /api/payroll/uif-declaration?action=export-csv — SARS-format CSV download
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest, withWriteAccess } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { csvCell } from '@/lib/csv';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export interface UifEmployeeRow {
  employee_id: string;
  employee_number: string;
  employee_name: string;
  id_number: string;
  gross_salary: number;
  uif_employee: number;
  uif_employer: number;
  total_uif: number;
}

export interface UifDeclarationResult {
  month: string;
  total_employees: number;
  total_uif_employee: number;
  total_uif_employer: number;
  grand_total: number;
  employees: UifEmployeeRow[];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function validateMonth(m: unknown): m is string {
  return typeof m === 'string' && /^\d{4}-\d{2}$/.test(m);
}

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;

  // ── GET: compute UIF declaration for a month ──────────────────────────────────
  if (req.method === 'GET') {
    const { month } = req.query;
    if (!validateMonth(month)) {
      return apiResponse.badRequest(res, 'month parameter is required in YYYY-MM format');
    }

    const periodStart = `${month}-01`;

    try {
      // Find payroll runs for the month
      const runRows = (await sql`
        SELECT id FROM payroll_runs
        WHERE company_id  = ${companyId}::UUID
          AND status      IN ('draft', 'completed')
          AND period_start >= ${periodStart}::DATE
          AND period_start < (DATE_TRUNC('month', ${periodStart}::DATE) + INTERVAL '1 month')
      `) as Row[];

      if (runRows.length === 0) {
        const empty: UifDeclarationResult = {
          month,
          total_employees: 0,
          total_uif_employee: 0,
          total_uif_employer: 0,
          grand_total: 0,
          employees: [],
        };
        return apiResponse.success(res, empty);
      }

      const runIds = runRows.map((r: Row) => String(r.id));

      const empRows = (await sql`
        SELECT
          e.id               AS employee_id,
          e.employee_number,
          e.first_name,
          e.last_name,
          COALESCE(e.id_number, '')                      AS id_number,
          COALESCE(SUM(ps.gross_pay),    0)::NUMERIC     AS gross_salary,
          COALESCE(SUM(ps.uif_employee), 0)::NUMERIC     AS uif_employee,
          COALESCE(SUM(ps.uif_employer), 0)::NUMERIC     AS uif_employer
        FROM payslips ps
        JOIN employees e ON ps.employee_id = e.id
        WHERE ps.payroll_run_id = ANY(${runIds}::UUID[])
          AND e.company_id     = ${companyId}::UUID
        GROUP BY e.id, e.employee_number, e.first_name, e.last_name, e.id_number
        ORDER BY e.last_name, e.first_name
      `) as Row[];

      const employees: UifEmployeeRow[] = empRows.map((r: Row) => {
        const uif_emp = round2(Number(r.uif_employee));
        const uif_emr = round2(Number(r.uif_employer));
        return {
          employee_id:     String(r.employee_id),
          employee_number: String(r.employee_number),
          employee_name:   `${r.first_name} ${r.last_name}`.trim(),
          id_number:       String(r.id_number),
          gross_salary:    round2(Number(r.gross_salary)),
          uif_employee:    uif_emp,
          uif_employer:    uif_emr,
          total_uif:       round2(uif_emp + uif_emr),
        };
      });

      const result: UifDeclarationResult = {
        month,
        total_employees:    employees.length,
        total_uif_employee: round2(employees.reduce((s, e) => s + e.uif_employee, 0)),
        total_uif_employer: round2(employees.reduce((s, e) => s + e.uif_employer, 0)),
        grand_total:        round2(employees.reduce((s, e) => s + e.total_uif, 0)),
        employees,
      };

      log.info('UIF declaration fetched', { companyId, month, count: employees.length }, 'uif-api');
      return apiResponse.success(res, result);
    } catch (err) {
      log.error('UIF GET failed', { error: err }, 'uif-api');
      return apiResponse.internalError(res, err, 'Failed to fetch UIF declaration');
    }
  }

  // ── POST ?action=export-csv ───────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action } = req.query;
    if (action !== 'export-csv') {
      return apiResponse.badRequest(res, 'Invalid action — use ?action=export-csv');
    }

    const { month } = req.body ?? {};
    if (!validateMonth(month)) {
      return apiResponse.badRequest(res, 'month is required in YYYY-MM format');
    }

    const periodStart = `${month}-01`;

    try {
      const runRows = (await sql`
        SELECT id FROM payroll_runs
        WHERE company_id  = ${companyId}::UUID
          AND status      IN ('draft', 'completed')
          AND period_start >= ${periodStart}::DATE
          AND period_start < (DATE_TRUNC('month', ${periodStart}::DATE) + INTERVAL '1 month')
      `) as Row[];

      const runIds = runRows.map((r: Row) => String(r.id));

      const empRows = runIds.length === 0 ? [] : (await sql`
        SELECT
          e.employee_number,
          e.first_name,
          e.last_name,
          COALESCE(e.id_number, '')                      AS id_number,
          COALESCE(SUM(ps.gross_pay),    0)::NUMERIC     AS gross_salary,
          COALESCE(SUM(ps.uif_employee), 0)::NUMERIC     AS uif_employee,
          COALESCE(SUM(ps.uif_employer), 0)::NUMERIC     AS uif_employer
        FROM payslips ps
        JOIN employees e ON ps.employee_id = e.id
        WHERE ps.payroll_run_id = ANY(${runIds}::UUID[])
          AND e.company_id     = ${companyId}::UUID
        GROUP BY e.employee_number, e.first_name, e.last_name, e.id_number
        ORDER BY e.last_name, e.first_name
      `) as Row[];

      // SARS UIF CSV format
      const header = [
        'Employee Number',
        'Surname',
        'First Name',
        'ID Number',
        'Gross Remuneration',
        'UIF Employee Contribution',
        'UIF Employer Contribution',
        'Total UIF',
      ].map(csvCell).join(',');

      const lines = empRows.map((r: Row) => {
        const uifEmp = round2(Number(r.uif_employee));
        const uifEmr = round2(Number(r.uif_employer));
        return [
          csvCell(r.employee_number),
          csvCell(r.last_name),
          csvCell(r.first_name),
          csvCell(r.id_number),
          csvCell(round2(Number(r.gross_salary))),
          csvCell(uifEmp),
          csvCell(uifEmr),
          csvCell(round2(uifEmp + uifEmr)),
        ].join(',');
      });

      const csv = [header, ...lines].join('\r\n');
      const filename = `UIF_Declaration_${month}.csv`;

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      log.info('UIF CSV exported', { companyId, month, rows: empRows.length }, 'uif-api');
      return res.status(200).send(csv);
    } catch (err) {
      log.error('UIF CSV export failed', { error: err }, 'uif-api');
      return apiResponse.internalError(res, err, 'Failed to export UIF CSV');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(withWriteAccess(handler)));
