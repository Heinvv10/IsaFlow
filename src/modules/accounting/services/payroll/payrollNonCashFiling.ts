/**
 * Non-cash fringe benefits the declared runs carried, per employee and SARS source code, for the
 * IRP5 data (irp5DataService), the e@syFile file (easyfile-export) and the EMP501 export.
 *
 * A non-cash benefit (today only the low-interest loan benefit, which appendLoanComponents injects
 * on the taxable earning coded 3801) is taxed but not paid, so it is NOT in the line's gross_pay:
 * it is the breakdown item flagged `isNonCash: true` (payrollCalculator's design note). A
 * certificate therefore shows it under its own code beside the cash income codes, never inside
 * 3601: 3601 + 3605 + lump sums (the cash gross) + these = the remuneration taxed. Its PAYE is in
 * the line's paye, so in 4102 like the rest.
 *
 * Code: SARS PAYE-AE-06-G06 (2026, Rev 13, p. 16; 2027, Rev 14, p. 16) code 3801 "General fringe
 * benefits" lists "low interest or interest free loans and subsidies"; the old 3807 must be
 * included in 3801 from the 2010 year of assessment. BRS PAYE Employer Reconciliation (V25.2.0,
 * Apr-26) file layout: 3801 is an income code, N15, cents omitted.
 *
 * Only flagged items: a line costed before the flag existed paid its 3801 in cash, inside
 * gross_pay, so it stays in 3601 as it was paid. That is said, never silent:
 * listRunUnflaggedFringe names the amount per employee (unflaggedFringeWarning), for the IRP5
 * data and the e@syFile export's warnings. Declarable runs and the tax year as
 * listRunAnnualPayments reads them; codes after the calculator's trim.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { formatMoney } from '@/lib/money/formatMoney';

export interface NonCashBenefitFiling {
  /** SARS income source code the benefit is certified under, e.g. '3801'. */
  sourceCode: string;
  amount: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The sum of an employee's non-cash benefits (all codes). */
export function nonCashTotal(benefits: readonly NonCashBenefitFiling[]): number {
  return round2(benefits.reduce((s, b) => s + b.amount, 0));
}

/** By employee id, each employee's codes in code order. `bounds` is the tax year (saTaxYearBounds). */
export async function listRunNonCashBenefits(
  companyId: string,
  bounds: { start: string; end: string },
  employeeId: string | null = null,
): Promise<Map<string, NonCashBenefitFiling[]>> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT l.employee_id,
           regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS source_code,
           SUM((item->>'amount')::numeric)::numeric AS amount
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.component_breakdown) = 'array'
      THEN l.component_breakdown ELSE '[]'::jsonb END) AS item
    WHERE h.company_id = ${companyId}::uuid
      AND h.status = ANY(${declarable}::text[])
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
      AND (${employeeId}::uuid IS NULL OR l.employee_id = ${employeeId}::uuid)
      AND item->>'isNonCash' = 'true'
    GROUP BY l.employee_id, regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g')
    ORDER BY l.employee_id, source_code
  `) as DbRow[];
  const out = new Map<string, NonCashBenefitFiling[]>();
  for (const r of rows) {
    const amount = round2(Number(r.amount));
    if (amount <= 0) continue; // BRS: no negative amounts, and a nil field is left out
    const key = String(r.employee_id);
    out.set(key, [...(out.get(key) ?? []), { sourceCode: String(r.source_code), amount }]);
  }
  return out;
}

/**
 * By employee id: the 3801 items the declared runs carried WITHOUT the flag (a line from before
 * the benefit was non-cash, or a 3801 component paid as cash), which gross_pay and so 3601 hold.
 */
export async function listRunUnflaggedFringe(
  companyId: string,
  bounds: { start: string; end: string },
  employeeId: string | null = null,
): Promise<Map<string, number>> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT l.employee_id, SUM((item->>'amount')::numeric)::numeric AS amount
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(l.component_breakdown) = 'array'
      THEN l.component_breakdown ELSE '[]'::jsonb END) AS item
    WHERE h.company_id = ${companyId}::uuid
      AND h.status = ANY(${declarable}::text[])
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
      AND (${employeeId}::uuid IS NULL OR l.employee_id = ${employeeId}::uuid)
      AND regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3801'
      AND item->>'isNonCash' IS DISTINCT FROM 'true'
    GROUP BY l.employee_id
  `) as DbRow[];
  return new Map(rows.map((r) => [String(r.employee_id), round2(Number(r.amount))] as const).filter(([, a]) => a !== 0));
}

/** The warning for an employee whose 3801 items were paid in cash and so are certified in 3601. */
export function unflaggedFringeWarning(employee: string, amount: number): string {
  return `${employee}: ${formatMoney(amount)} of code 3801 items this tax year was paid in cash inside gross pay `
    + '(a run costed before the loan benefit was non-cash, or a 3801 component paid as cash), so it is certified in 3601, '
    + 'not 3801. Check the certificate before filing it.';
}
