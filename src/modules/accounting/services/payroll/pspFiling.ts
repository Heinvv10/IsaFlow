/**
 * A personal service provider's months on the year-end filings (wave 6 PSP, review of #1566 H1/H2/M2). Decided PER LINE
 * (pspLineFlag), never from the employee's tax status today.
 *
 * A PSP's certificate is the company's or trust's, not the natural person's: nature of person H "Personal Service
 * Provider" (SARS PAYE Employer Reconciliation BRS V25.3.0 p. 17, the same in V23.0.0 and V22.1.2), a separate certificate
 * where the nature of person changed during the year (the same page), the trading name in 3030 and no names, ID or date
 * of birth (pp. 17-26), an income tax reference starting with 9 (p. 26), and the payments under 3601 (PAYE-GEN-01-G21
 * (2027) Rev 1 p. 31). IsaFlow holds none of the entity's particulars (trading name, registration number, tax reference),
 * so it does not write that certificate. UNVERIFIED: every natural-person filing leaves the PSP lines out, and each
 * filing names them with their PAYE, so the EMP501's PAYE difference is explained and the certificate is issued by hand.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { payRunFinalSql } from './payRunFinalSql';
import { pspLineFlag } from './payrollOutsideTables';
import { payeTaxYearBounds, payeTaxYearOf } from '@/modules/accounting/utils/payeTaxYear';

export interface PspFilingTotal {
  employeeId: string;
  employeeNumber: string;
  name: string;
  gross: number;
  paye: number;
  sdl: number;
  /** Whether the employee also has non-PSP lines on the year's final runs (a natural-person certificate too). */
  alsoEmployee: boolean;
}

/** The PSP lines on the final runs whose period is within [start, end], by employee (this company only). */
export async function listPspFilingTotals(
  companyId: string, bounds: { start: string; end: string }, employeeId: string | null = null,
): Promise<PspFilingTotal[]> {
  const rows = (await sql`
    SELECT e.id::text AS employee_id, e.employee_number, e.first_name, e.last_name,
           SUM(l.gross_pay) FILTER (WHERE l.validation_results @> ${pspLineFlag}::jsonb)::numeric AS gross,
           SUM(l.paye) FILTER (WHERE l.validation_results @> ${pspLineFlag}::jsonb)::numeric AS paye,
           SUM(l.sdl) FILTER (WHERE l.validation_results @> ${pspLineFlag}::jsonb)::numeric AS sdl,
           bool_or(NOT COALESCE(l.validation_results @> ${pspLineFlag}::jsonb, false)) AS also_employee
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
      JOIN payroll_employees e ON e.id = l.employee_id AND e.company_id = h.company_id
     WHERE h.company_id = ${companyId}::uuid
       AND ${sql.unsafe(payRunFinalSql('h'))}
       AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
       AND (${employeeId}::uuid IS NULL OR e.id = ${employeeId}::uuid)
     GROUP BY e.id, e.employee_number, e.first_name, e.last_name
    HAVING bool_or(COALESCE(l.validation_results @> ${pspLineFlag}::jsonb, false))
     ORDER BY e.last_name, e.first_name, e.id
  `) as DbRow[];
  const r2 = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
  return rows.map((r) => ({
    employeeId: String(r.employee_id), employeeNumber: String(r.employee_number ?? ''),
    name: `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim(),
    gross: r2(r.gross), paye: r2(r.paye), sdl: r2(r.sdl), alsoEmployee: r.also_employee === true,
  }));
}

/** The named warning a filing gives for each PSP's months it leaves out. */
export function pspFilingWarning(t: PspFilingTotal, filing: string): string {
  return `${t.name} (${t.employeeNumber}): ${formatMoney(t.gross)} paid as a personal service provider (PAYE ${formatMoney(t.paye)}, `
    + `SDL ${formatMoney(t.sdl)}) is not on the ${filing}${t.alsoEmployee ? ' (the months paid as an employee are)' : ''}. `
    + 'A PSP\'s certificate is the company\'s or trust\'s: nature of person H, payments under 3601 (SARS PAYE Employer '
    + 'Reconciliation BRS V25.3.0 p. 17; PAYE-GEN-01-G21 p. 31), which IsaFlow does not produce. Issue it in e@syFile with the '
    + 'entity\'s trading name and tax reference (starting with 9). UNVERIFIED.';
}

/**
 * H2: a tax status moved into or out of PSP in a tax year that already has final runs for the employee. Not refused (the
 * filings split the year per line), but named: the year's certificates now split in two (a natural person's and the
 * PSP's), and SARS's BRS (V25.3.0 p. 17) asks for a separate certificate when the nature of person changes. Null otherwise.
 */
export async function pspSwitchWarning(
  companyId: string, employeeId: string, before: string | null, after: string | null, today = new Date(),
): Promise<string | null> {
  const psp = 'personal_service_provider';
  if (before === after || (before !== psp && after !== psp)) return null;
  const taxYear = payeTaxYearOf(today.getMonth() + 1, today.getFullYear());
  const { start, end } = payeTaxYearBounds(taxYear);
  const rows = (await sql`
    SELECT count(DISTINCT h.id)::int AS runs
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
     WHERE h.company_id = ${companyId}::uuid AND l.employee_id = ${employeeId}::uuid
       AND ${sql.unsafe(payRunFinalSql('h'))}
       AND make_date(h.period_year, h.period_month, 1) BETWEEN ${start}::date AND ${end}::date
  `) as DbRow[];
  const runs = Number(rows[0]?.runs ?? 0);
  if (runs === 0) return null;
  return `The tax status moved ${after === psp ? 'to' : 'from'} personal service provider in the ${taxYear - 1}/${taxYear} tax year, `
    + `which already has ${runs} final run(s) for this person. Earlier months keep how they were taxed: the year's filings split `
    + 'per month into a natural person\'s certificate and the PSP\'s (a separate certificate, SARS PAYE Employer Reconciliation BRS '
    + 'V25.3.0 p. 17). Check the change is meant to apply from the next run.';
}

/**
 * The same for a reader without payroll-detail access (a viewer of an aggregate-only route): one line, the PSP lines'
 * total PAYE and count, no name, employee number or per-person amount. Null when there is none.
 */
export function pspAggregateWarning(totals: readonly PspFilingTotal[], filing: string): string | null {
  if (totals.length === 0) return null;
  const paye = Math.round(totals.reduce((t, x) => t + x.paye, 0) * 100) / 100;
  return `${formatMoney(paye)} of PAYE on personal service provider pay (${totals.length} payee${totals.length === 1 ? '' : 's'}) is not on the `
    + `${filing}: a PSP's certificate is the company's or trust's (nature of person H), which IsaFlow does not produce. UNVERIFIED.`;
}
