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
 * The directive issued date (BRS code 3231) is the directive's issued_date
 * (migration 912), else its effective_date with `issuedDateFallback` set, which
 * the callers turn into a warning naming the directive.
 *
 * Directives paid OUTSIDE payroll (tax_directive_payments with no
 * payroll_run_id) are directivePaymentFiling's; listCertificateLumpSums there
 * unions both. A row is one kind or the other (migration 901 CHECK), so the
 * union counts each payment once.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';

export interface LumpSumFiling {
  directiveId: string;
  /** SARS income source code, e.g. '3901'. */
  sourceCode: string;
  directiveNumber: string | null;
  /** YYYY-MM-DD: the issued date, else the effective date. */
  directiveIssuedDate: string;
  /** True when the directive has no issued date and 3231 carries its effective date. */
  issuedDateFallback: boolean;
  amount: number;
  paye: number;
  /** Where its PAYE is declared: 4115 for 3901/3915/3920-3924, else 4102 (lumpSumPayeCode). */
  payeCode: '4115' | '4102';
  /** Paid in a payroll run, or outside payroll (applyTaxDirective). */
  paidBy: 'run' | 'standalone';
}

/**
 * SARS BRS PAYE Employer Reconciliation V25.3.0, p. 57: 4115 is "PAYE on
 * retirement lump sum and severance benefits reported under codes 3901, 3915,
 * 3920, 3921, 3922, 3923, and 3924" (3951 is 3901's foreign-service twin).
 * SARS PAYE-GEN-01-G21 (2027) p. 21: the tax on 3902-3905, 3907-3909 and 3614
 * is reflected under 4102.
 */
const PAYE_4115_CODES = new Set(['3901', '3951', '3915', '3920', '3921', '3922', '3923', '3924']);
export function lumpSumPayeCode(sourceCode: string): '4115' | '4102' {
  return PAYE_4115_CODES.has(sourceCode) ? '4115' : '4102';
}

/** A directive's 3231 date: its issued date, else its effective date (flagged). */
export function directiveIssuedDate(r: DbRow): { directiveIssuedDate: string; issuedDateFallback: boolean } {
  return r.issued_date == null
    ? { directiveIssuedDate: fmtDate(r.effective_date), issuedDateFallback: true }
    : { directiveIssuedDate: fmtDate(r.issued_date), issuedDateFallback: false };
}

/** The warning for a lump sum whose 3231 fell back to the effective date, naming the directive. */
export function issuedDateWarning(employee: string, l: LumpSumFiling): string {
  return `${employee}: SARS directive ${l.directiveNumber ?? l.directiveId} has no issued date, so its effective date `
    + `${l.directiveIssuedDate} is filed as the issued date (code 3231). Enter the date SARS issued it on the directive.`;
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
    SELECT l.employee_id, regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g') AS source_code,
           d.id AS directive_id, d.directive_number, d.effective_date, d.issued_date,
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
    GROUP BY l.employee_id, regexp_replace(item->>'sarsSourceCode', '^[ \t\r\n]+|[ \t\r\n]+$', '', 'g'), d.id, d.directive_number, d.effective_date, d.issued_date
    ORDER BY l.employee_id, d.effective_date, d.id
  `) as DbRow[];
  const out = new Map<string, LumpSumFiling[]>();
  for (const r of rows) {
    const key = String(r.employee_id);
    const list = out.get(key) ?? [];
    const sourceCode = String(r.source_code);
    list.push({
      directiveId: String(r.directive_id),
      sourceCode,
      directiveNumber: r.directive_number == null ? null : String(r.directive_number),
      ...directiveIssuedDate(r),
      amount: round2(Number(r.amount)),
      paye: round2(Number(r.paye)),
      payeCode: lumpSumPayeCode(sourceCode),
      paidBy: 'run',
    });
    out.set(key, list);
  }
  return out;
}

/**
 * A certificate's income and PAYE split from the totals (which include every
 * lump sum): lump sums under their own code (their PAYE to 4115 when the code
 * takes it, lumpSumPayeCode, else it stays in 4102), annual payments under
 * 3605, the rest 3601 / 4102. A tax year whose 3605 nets negative (a
 * clawback) stays in 3601, as the calculator taxes it.
 */
export function splitCertificateIncome(t: {
  gross: number; paye: number; annualPayments: number; lumpSums: Array<{ sourceCode: string; amount: number; paye: number }>;
}): { grossSalary3601: number; annualPayments3605: number; paye4102: number } {
  const r2 = (n: number): number => Math.round(n * 100) / 100;
  const annual = Math.max(0, t.annualPayments);
  const lumpGross = t.lumpSums.reduce((s, l) => s + l.amount, 0);
  const lumpPaye = t.lumpSums.filter(l => lumpSumPayeCode(l.sourceCode) === '4115').reduce((s, l) => s + l.paye, 0);
  return { grossSalary3601: r2(t.gross - lumpGross - annual), annualPayments3605: r2(annual), paye4102: r2(t.paye - lumpPaye) };
}
