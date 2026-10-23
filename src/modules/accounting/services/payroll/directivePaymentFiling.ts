/**
 * SARS directives paid OUTSIDE payroll (applyTaxDirective: a
 * tax_directive_payments row with no payroll_run_id and its own journal) on the
 * returns: the EMP201 of the month of the payment's posted journal, and the
 * employee's certificate for the tax year of that date. PAYE 4a follow-ups G1.
 *
 * Only a payment whose journal is posted and in force is declared (its
 * reversal chain's net, payrollJournalInForce: a reversal can be reversed in
 * turn): the journal is what put the PAYE in 2140. Dated by the journal's
 * entry_date, not by when the row was written.
 *
 * Income code by directive type (directiveSourceCode). Every type IsaFlow pays
 * this way is an employer's lump sum on an IRP3(a) directive (G21 p. 15:
 * "IRP3(a) - Severance benefit paid by employer (e.g. death/retirement/
 * retrenchment) ... or other lump sums"):
 * - severance, retirement, death: 3901. SARS PAYE-GEN-01-G21 (2027) Rev 1,
 *   p. 15: "Retrenchment, retirement or death: Lump sum amount paid due to
 *   retrenchment, retirement, etc. reflect on IRP5/IT3(a) certificate under
 *   code 3901"; p. 22: the tax under 4115.
 * - lump_sum: 3907, "Other lump sums" (PAYE-AE-06-G06 (2026) Rev 13, p. 22);
 *   its tax under 4102 (G21 p. 21).
 * Fund benefits (3915, 3920, 3921) are paid and certified by the fund, not the
 * employer (G21 p. 20-21), so no IsaFlow directive type maps to them.
 *
 * Every query is scoped by company_id.
 */

import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';
import { directiveIssuedDate, listRunLumpSums, lumpSumPayeCode, type LumpSumFiling } from './payrollLumpSumFiling';
import { payrollJournalInForce } from './payrollJournalChain';

const round2 = (n: number): number => Math.round(n * 100) / 100;

export function directiveSourceCode(directiveType: string): '3901' | '3907' {
  return directiveType === 'lump_sum' ? '3907' : '3901';
}

export interface StandaloneDirectivePayment {
  paymentId: string;
  directiveId: string;
  directiveNumber: string | null;
  /** Null when the directive names no employee in this company (no certificate can carry it). */
  employeeId: string | null;
  employeeName: string;
  /** The posted journal's entry date, YYYY-MM-DD. */
  paymentDate: string;
  gross: number;
  paye: number;
  filing: LumpSumFiling;
}

/** Stand-alone payments whose posted journal is dated within [start, end]. */
export async function listStandaloneDirectivePayments(
  companyId: string,
  bounds: { start: string; end: string },
  employeeId: string | null = null,
): Promise<StandaloneDirectivePayment[]> {
  const rows = (await sql`
    SELECT tdp.id AS payment_id, tdp.gross_amount, tdp.paye_amount, je.entry_date,
           d.id AS directive_id, d.directive_number, d.directive_type, d.employee_name,
           d.effective_date, d.issued_date, e.id AS employee_id, je.id AS journal_id, je.reversed_at
    FROM tax_directive_payments tdp
    JOIN tax_directives d ON d.id = tdp.tax_directive_id AND d.company_id = tdp.company_id
    JOIN gl_journal_entries je ON je.id = tdp.journal_entry_id AND je.company_id = tdp.company_id
    LEFT JOIN payroll_employees e ON e.id = d.employee_id AND e.company_id = d.company_id
    WHERE tdp.company_id = ${companyId}::uuid
      AND tdp.payroll_run_id IS NULL
      AND je.status = 'posted'
      AND je.entry_date BETWEEN ${bounds.start}::date AND ${bounds.end}::date
      AND (${employeeId}::uuid IS NULL OR e.id = ${employeeId}::uuid)
    ORDER BY je.entry_date, tdp.id
  `) as DbRow[];
  // A posted journal nothing has reversed is in force; only a reversed one needs its chain read.
  const inForce = await Promise.all(rows.map(r => r.reversed_at == null || payrollJournalInForce(companyId, String(r.journal_id))));
  return rows.filter((_, i) => inForce[i]).map((r) => {
    const sourceCode = directiveSourceCode(String(r.directive_type));
    const gross = round2(Number(r.gross_amount));
    const paye = round2(Number(r.paye_amount));
    const directiveNumber = r.directive_number == null ? null : String(r.directive_number);
    return {
      paymentId: String(r.payment_id),
      directiveId: String(r.directive_id),
      directiveNumber,
      employeeId: r.employee_id == null ? null : String(r.employee_id),
      employeeName: String(r.employee_name ?? ''),
      paymentDate: fmtDate(r.entry_date),
      gross,
      paye,
      filing: {
        directiveId: String(r.directive_id), sourceCode, directiveNumber, ...directiveIssuedDate(r),
        amount: gross, paye, payeCode: lumpSumPayeCode(sourceCode), paidBy: 'standalone',
      },
    };
  });
}

export interface CertificateLumpSums {
  /** Run-paid and stand-alone lump sums by employee id, in issued-date order. */
  byEmployee: Map<string, LumpSumFiling[]>;
  /** The stand-alone payments' gross and PAYE by employee id: NOT in the run-line totals, so callers add them. */
  standaloneTotals: Map<string, { gross: number; paye: number }>;
  /** Stand-alone payments whose directive names no employee here. */
  unlinked: StandaloneDirectivePayment[];
}

/** Every lump sum a certificate for the tax year `bounds` carries: the runs' and the stand-alone payments'. */
export async function listCertificateLumpSums(
  companyId: string,
  bounds: { start: string; end: string },
  employeeId: string | null = null,
): Promise<CertificateLumpSums> {
  const [run, standalone] = await Promise.all([
    listRunLumpSums(companyId, bounds, employeeId),
    listStandaloneDirectivePayments(companyId, bounds, employeeId),
  ]);
  const byEmployee = new Map([...run].map(([k, v]) => [k, [...v]]));
  const standaloneTotals = new Map<string, { gross: number; paye: number }>();
  for (const p of standalone) {
    if (p.employeeId == null) continue;
    byEmployee.set(p.employeeId, [...(byEmployee.get(p.employeeId) ?? []), p.filing]);
    const t = standaloneTotals.get(p.employeeId) ?? { gross: 0, paye: 0 };
    standaloneTotals.set(p.employeeId, { gross: round2(t.gross + p.gross), paye: round2(t.paye + p.paye) });
  }
  for (const list of byEmployee.values()) {
    list.sort((a, b) => a.directiveIssuedDate.localeCompare(b.directiveIssuedDate) || a.directiveId.localeCompare(b.directiveId));
  }
  return { byEmployee, standaloneTotals, unlinked: standalone.filter(p => p.employeeId == null) };
}
