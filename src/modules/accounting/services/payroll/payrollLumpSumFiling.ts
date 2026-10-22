/**
 * Lump sums paid in payroll runs under a SARS directive, per employee, for the
 * IRP5 data (irp5DataService) and the e@syFile file (easyfile-export). Audit
 * 2026-10-18 P3.
 *
 * Read from the run lines, so a certificate carries exactly what the declared
 * runs paid: every breakdown item paid under a directive (`directive` set, which
 * only a lump sum carries; the approval gate refuses a lump sum without one): the directive line's amount and PAYE (they are in the line's
 * gross_pay and paye, which therefore include them), and the directive's
 * number from the directive row. Declarable runs only, in the SA tax year, as
 * irp5DataService and EMP201 count them.
 *
 * The directive issued date (BRS code 3231) is the directive's effective_date:
 * tax_directives has no separate issue date, and the effective date captured is
 * the date on the directive.
 *
 * Not here: directives paid outside payroll (tax_directive_payments with no
 * payroll_run_id — retirement or death lump sums) reach neither EMP201 nor the
 * IRP5; named as a gap in the P3 PR.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';

export interface LumpSumFiling {
  /** SARS income source code, e.g. '3901'. */
  sourceCode: string;
  directiveNumber: string | null;
  /** YYYY-MM-DD. */
  directiveIssuedDate: string;
  amount: number;
  paye: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Annual payments (3605) the declared runs paid, by employee id, for the
 * e@syFile 3605 field (SARS PAYE-GEN-01-G21 (2027) p. 33). Their PAYE stays in
 * 4102: the SARS annual-payment method is employees' tax, not a lump-sum tax.
 */
export async function listRunAnnualPayments(
  companyId: string,
  bounds: { start: string; end: string },
): Promise<Map<string, number>> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  // Netted per run LINE and floored at nil there, as the calculator does: a line
  // whose 3605 nets negative was taxed as regular pay, so it stays in 3601.
  const rows = (await sql`
    SELECT per_line.employee_id, SUM(GREATEST(per_line.amount, 0))::numeric AS amount
    FROM (
      SELECT l.id, l.employee_id, SUM((item->>'amount')::numeric) AS amount
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
      CROSS JOIN LATERAL jsonb_array_elements(l.component_breakdown) AS item
      WHERE h.company_id = ${companyId}::uuid
        AND h.status = ANY(${declarable}::text[])
        AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
        AND regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') = '3605'
        AND (item->>'isTaxable')::boolean
      GROUP BY l.id, l.employee_id
    ) per_line
    GROUP BY per_line.employee_id
  `) as DbRow[];
  return new Map(rows.map(r => [String(r.employee_id), round2(Number(r.amount))]));
}

/** By employee id. `bounds` is the tax year (saTaxYearBounds). */
export async function listRunLumpSums(
  companyId: string,
  bounds: { start: string; end: string },
  employeeId: string | null = null,
): Promise<Map<string, LumpSumFiling[]>> {
  const { start, end } = bounds;
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT l.employee_id, regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS source_code, d.directive_number, d.effective_date,
           SUM((item->>'amount')::numeric)::numeric AS amount,
           SUM((item->'directive'->>'paye')::numeric)::numeric AS paye
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
    CROSS JOIN LATERAL jsonb_array_elements(l.component_breakdown) AS item
    JOIN tax_directives d ON d.id = (item->'directive'->>'id')::uuid AND d.company_id = h.company_id
    WHERE h.company_id = ${companyId}::uuid
      AND h.status = ANY(${declarable}::text[])
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${start}::date AND ${end}::date
      AND (${employeeId}::uuid IS NULL OR l.employee_id = ${employeeId}::uuid)
      AND item->'directive' IS NOT NULL
    GROUP BY l.employee_id, regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g'), d.id, d.directive_number, d.effective_date
    ORDER BY l.employee_id, d.effective_date, d.id
  `) as DbRow[];
  const out = new Map<string, LumpSumFiling[]>();
  for (const r of rows) {
    const key = String(r.employee_id);
    const list = out.get(key) ?? [];
    list.push({
      sourceCode: String(r.source_code),
      directiveNumber: r.directive_number == null ? null : String(r.directive_number),
      directiveIssuedDate: fmtDate(r.effective_date),
      amount: round2(Number(r.amount)),
      paye: round2(Number(r.paye)),
    });
    out.set(key, list);
  }
  return out;
}

/**
 * A certificate's income and PAYE split from the run totals: lump sums under
 * their own code (PAYE to 4115), annual payments under 3605, the rest 3601 /
 * 4102. A tax year whose 3605 nets negative (a clawback) stays in 3601, as the
 * calculator taxes it.
 */
export function splitCertificateIncome(t: {
  gross: number; paye: number; annualPayments: number; lumpSums: Array<{ amount: number; paye: number }>;
}): { grossSalary3601: number; annualPayments3605: number; paye4102: number } {
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const annual = Math.max(0, t.annualPayments);
  const lumpGross = t.lumpSums.reduce((s, l) => s + l.amount, 0);
  const lumpPaye = t.lumpSums.reduce((s, l) => s + l.paye, 0);
  return { grossSalary3601: r2(t.gross - lumpGross - annual), annualPayments3605: r2(annual), paye4102: r2(t.paye - lumpPaye) };
}
