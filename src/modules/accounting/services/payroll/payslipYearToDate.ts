/**
 * A payslip's year to date (wave 4 PS): the employee's stored lines on the runs of
 * the same PAYE tax year (1 March to February, `payeTaxYearOf`), up to and including
 * this run's period, that are FINAL by the same test the slip uses (the approval stamp, `payslipFinal`),
 * plus this run's own line. A DRAFT slip's year to date therefore includes its own
 * draft figures, under the slip's DRAFT mark.
 *
 * Its own query, deliberately: it does not import `irp5DataService`, so the test that
 * ties a February slip's year to date to the IRP5 year totals compares two
 * independent reads. Nothing is recalculated; every figure is a sum of stored ones.
 */
import { sql } from '@/lib/neon';
import { PAYE_TAX_YEAR_START_MONTH, payeTaxYearOf } from '@/modules/accounting/utils/payeTaxYear';

export interface PayslipYearToDate {
  grossPay: number;
  taxableIncome: number;
  paye: number;
  uifEmployee: number;
  netPay: number;
}

interface YtdRow {
  run_id: string;
  employee_id: string;
  gross_pay: string | number;
  taxable_income: string | number;
  paye: string | number;
  uif_employee: string | number;
  net_pay: string | number;
  final: boolean;
}

const ZERO: PayslipYearToDate = { grossPay: 0, taxableIncome: 0, paye: 0, uifEmployee: 0, netPay: 0 };
const round2 = (n: number): number => Math.round(n * 100) / 100;

function add(total: PayslipYearToDate, row: YtdRow): PayslipYearToDate {
  return {
    grossPay: round2(total.grossPay + Number(row.gross_pay)),
    taxableIncome: round2(total.taxableIncome + Number(row.taxable_income)),
    paye: round2(total.paye + Number(row.paye)),
    uifEmployee: round2(total.uifEmployee + Number(row.uif_employee)),
    netPay: round2(total.netPay + Number(row.net_pay)),
  };
}

/** Year to date per employee of `employeeIds`, for run `runId` of (`periodYear`, `periodMonth`). */
export async function payslipYearToDate(
  companyId: string,
  run: { id: string; periodMonth: number; periodYear: number },
  employeeIds: string[],
): Promise<Map<string, PayslipYearToDate>> {
  const startYear = payeTaxYearOf(run.periodMonth, run.periodYear) - 1;
  // Bounded by period, not by run: "up to and including this period" is this run alone only because
  // payroll_run_headers is UNIQUE (company_id, period_year, period_month). The year-to-date test in
  // tests/integration/payslips.int.test.ts inserts a second header and expects that unique_violation
  // (23505). Drop the constraint and this bound must name the run too.
  const rows = (await sql`
    SELECT prl.run_id::text AS run_id, prl.employee_id::text AS employee_id,
           prl.gross_pay, prl.taxable_income, prl.paye, prl.uif_employee, prl.net_pay,
           (prh.status IN ('approved', 'paid') AND prh.payslips_final_at IS NOT NULL) AS final
      FROM payroll_run_lines prl
      JOIN payroll_run_headers prh ON prh.id = prl.run_id
     WHERE prh.company_id = ${companyId}::uuid
       AND prl.employee_id::text = ANY(${employeeIds}::text[])
       AND (prh.period_year, prh.period_month) >= (${startYear}::int, ${PAYE_TAX_YEAR_START_MONTH}::int)
       AND (prh.period_year, prh.period_month) <= (${run.periodYear}::int, ${run.periodMonth}::int)
     ORDER BY prh.period_year, prh.period_month, prl.run_id
  `) as YtdRow[];

  const totals = new Map<string, PayslipYearToDate>(employeeIds.map((id) => [id, ZERO]));
  for (const row of rows) {
    if (row.run_id !== run.id && row.final !== true) continue; // this slip's own line always counts
    totals.set(row.employee_id, add(totals.get(row.employee_id) ?? ZERO, row));
  }
  return totals;
}
