/**
 * Payslips from a pay run's STORED lines (wave 4 PS). `getPayslips` reads the run
 * header, its lines and breakdowns, each employee's name, number, occupation and
 * tax number, the last four digits of the active bank account (cut in SQL, so the
 * whole number never leaves the database) and the year to date. Nothing is
 * recalculated (`payslipItems`). Final or DRAFT is `isPayRunFinal` alone, the
 * R-035 guard, never the status column. Never the ID number.
 *
 * Every read is scoped by company: a run of another company is `PayslipNotFound`,
 * as is an employee who has no line on the run.
 */
import { sql } from '@/lib/neon';
import { getCompanyDetailsFromCompany } from '@/modules/accounting/services/core/pdfShared';
import { itemisePayslip, type PayslipLines } from './payslipItems';
import { isPayRunFinal } from './payslipFinal';
import { payslipYearToDate, type PayslipYearToDate } from './payslipYearToDate';

export class PayslipNotFound extends Error {
  constructor(what: 'run' | 'employee') {
    super(what === 'run' ? 'Pay run not found' : 'This employee has no line on this pay run');
    this.name = 'PayslipNotFound';
  }
}

export interface Payslip extends PayslipLines {
  employeeId: string;
  employeeNumber: string;
  employeeName: string;
  occupation: string | null;
  taxNumber: string | null;
  paymentMethod: string;
  /** The active bank account's last four digits; null when none is on file. */
  bankLastFour: string | null;
  bankName: string | null;
  yearToDate: PayslipYearToDate;
}

export interface PayslipRun {
  runId: string;
  periodMonth: number;
  periodYear: number;
  runDate: string | null;
  /** R-035 cleared (or grandfathered): false prints DRAFT on every page. */
  final: boolean;
  employer: { name: string; address: string };
  payslips: Payslip[];
}

interface HeaderRow { period_month: number; period_year: number; run_date: string | Date | null }

interface LineRow {
  employee_id: string;
  employee_number: string;
  first_name: string;
  last_name: string;
  occupation: string | null;
  tax_number: string | null;
  payment_method: string;
  bank_last_four: string | null;
  bank_name: string | null;
  gross_pay: string | number;
  paye: string | number;
  uif_employee: string | number;
  uif_employer: string | number;
  sdl: string | number;
  net_pay: string | number;
  component_breakdown: unknown;
}

const dateOnly = (d: string | Date | null): string | null =>
  d == null ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);

async function readLines(companyId: string, runId: string, employeeIds: string[] | null): Promise<LineRow[]> {
  return (await sql`
    SELECT prl.employee_id::text AS employee_id, pe.employee_number, pe.first_name, pe.last_name,
           COALESCE(ol.name, NULLIF(BTRIM(pe.department), '')) AS occupation,
           pe.tax_number, pe.payment_method,
           RIGHT(bd.account_number, 4) AS bank_last_four, bd.bank_name,
           prl.gross_pay, prl.paye, prl.uif_employee, prl.uif_employer, prl.sdl, prl.net_pay,
           prl.component_breakdown
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
      JOIN payroll_employees pe ON pe.id = prl.employee_id AND pe.company_id = prh.company_id
      LEFT JOIN occupational_levels ol ON ol.id = pe.occupational_level_id
      LEFT JOIN payroll_bank_details bd
        ON bd.employee_id = pe.id AND bd.company_id = prh.company_id AND bd.is_active
     WHERE prl.run_id = ${runId}::uuid
       AND prh.company_id = ${companyId}::uuid
       AND (${employeeIds}::text[] IS NULL OR prl.employee_id::text = ANY(${employeeIds}::text[]))
     ORDER BY pe.employee_number
  `) as LineRow[];
}

/** The catalogue type of each component the breakdowns name, in this company only. */
async function componentTypes(companyId: string, lines: LineRow[]): Promise<Map<string, string>> {
  const ids = [...new Set(lines.flatMap((l) => (Array.isArray(l.component_breakdown) ? l.component_breakdown : [])
    .map((i: { componentId?: unknown }) => String(i?.componentId ?? '')).filter(Boolean)))];
  if (ids.length === 0) return new Map();
  const rows = (await sql`
    SELECT id::text AS id, component_type FROM payroll_components
     WHERE company_id = ${companyId}::uuid AND id::text = ANY(${ids}::text[])
  `) as Array<{ id: string; component_type: string }>;
  return new Map(rows.map((r) => [r.id, r.component_type]));
}

export async function getPayslips(companyId: string, runId: string, employeeIds?: string[]): Promise<PayslipRun> {
  const headers = (await sql`
    SELECT period_month, period_year, run_date FROM payroll_run_headers
     WHERE id = ${runId}::uuid AND company_id = ${companyId}::uuid
  `) as HeaderRow[];
  const header = headers[0];
  if (!header) throw new PayslipNotFound('run');

  const lines = await readLines(companyId, runId, employeeIds ?? null);
  if (lines.length === 0 || (employeeIds && lines.length !== new Set(employeeIds).size)) throw new PayslipNotFound('employee');

  const run = { id: runId, periodMonth: Number(header.period_month), periodYear: Number(header.period_year) };
  // One after another: they share the request's transaction connection.
  const final = await isPayRunFinal(companyId, runId);
  const types = await componentTypes(companyId, lines);
  const ytd = await payslipYearToDate(companyId, run, lines.map((l) => l.employee_id));
  const company = await getCompanyDetailsFromCompany(companyId);

  return {
    runId, periodMonth: run.periodMonth, periodYear: run.periodYear, runDate: dateOnly(header.run_date), final,
    employer: { name: company.name, address: company.address },
    payslips: lines.map((l): Payslip => ({
      ...itemisePayslip({
        grossPay: Number(l.gross_pay), paye: Number(l.paye), uifEmployee: Number(l.uif_employee),
        uifEmployer: Number(l.uif_employer), sdl: Number(l.sdl), netPay: Number(l.net_pay), breakdown: l.component_breakdown,
      }, types),
      employeeId: l.employee_id,
      employeeNumber: String(l.employee_number),
      employeeName: `${l.first_name} ${l.last_name}`.trim(),
      occupation: l.occupation,
      taxNumber: l.tax_number,
      paymentMethod: String(l.payment_method),
      bankLastFour: l.bank_last_four,
      bankName: l.bank_name,
      yearToDate: ytd.get(l.employee_id)!,
    })),
  };
}
