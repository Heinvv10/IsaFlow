/**
 * A personal service provider's months on the year-end filings (wave 6 PSP, review of #1566 H1/H2/M2). Decided PER LINE
 * (pspLineFlag), never from the employee's tax status today.
 *
 * A PSP's certificate is the company's or trust's, not the natural person's: nature of person H "Personal Service
 * Provider" (SARS PAYE Employer Reconciliation BRS V25.3.0 p. 17, the same in V23.0.0 and V22.1.2), a separate certificate
 * where the nature of person changed during the year (the same page), the trading name in 3030 and no names, ID or date
 * of birth (pp. 17-26), an income tax reference starting with 9 (p. 26), and the payments under 3601 (PAYE-GEN-01-G21
 * (2027) Rev 1 p. 31). Every natural-person filing leaves the PSP lines out and names them. With the entity's particulars
 * (trading name and tax reference, migration 1014) the e@syFile file carries the H certificate (easyFilePspCertificate,
 * wave 6 PSP-H) and the EMP501 counts them as certificates; without them the months are on no certificate and the warning
 * says to add the particulars.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { formatMoney } from '@/lib/money/formatMoney';
import { formatDisplayMonthYearLong } from '@/utils/dateFormat';
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
  /** The entity's trading name when its H certificate is in the e@syFile file (a trading name and a tax reference held), else null. */
  certifiedAs: string | null;
}

/** The PSP lines on the final runs whose period is within [start, end], by employee (this company only). */
export async function listPspFilingTotals(
  companyId: string, bounds: { start: string; end: string }, employeeId: string | null = null,
): Promise<PspFilingTotal[]> {
  const rows = (await sql`
    SELECT e.id::text AS employee_id, e.employee_number, e.first_name, e.last_name,
           CASE WHEN e.psp_tax_reference IS NOT NULL THEN e.psp_entity_name END AS certified_as,
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
     GROUP BY e.id, e.employee_number, e.first_name, e.last_name, e.psp_entity_name, e.psp_tax_reference
    HAVING bool_or(COALESCE(l.validation_results @> ${pspLineFlag}::jsonb, false))
     ORDER BY e.last_name, e.first_name, e.id
  `) as DbRow[];
  const r2 = (v: unknown) => Math.round(Number(v ?? 0) * 100) / 100;
  return rows.map((r) => ({
    employeeId: String(r.employee_id), employeeNumber: String(r.employee_number ?? ''),
    name: `${String(r.first_name ?? '')} ${String(r.last_name ?? '')}`.trim(),
    gross: r2(r.gross), paye: r2(r.paye), sdl: r2(r.sdl), alsoEmployee: r.also_employee === true,
    certifiedAs: r.certified_as == null ? null : String(r.certified_as),
  }));
}

/** The named note a filing gives for each PSP's months it leaves out: on the entity's own H certificate, or on none. */
export function pspFilingWarning(t: PspFilingTotal, filing: string): string {
  const what = `${t.name} (${t.employeeNumber}): ${formatMoney(t.gross)} paid as a personal service provider (PAYE ${formatMoney(t.paye)}, `
    + `SDL ${formatMoney(t.sdl)}) is not on the ${filing}${t.alsoEmployee ? ' (the months paid as an employee are)' : ''}. `;
  if (t.certifiedAs) {
    return `${what}It is on ${t.certifiedAs}'s own certificate in the e@syFile file: nature of person H, payments under 3601 `
      + '(SARS PAYE Employer Reconciliation BRS V25.3.0 p. 17; PAYE-GEN-01-G21 p. 31).';
  }
  return `${what}It is on no certificate: a PSP's certificate is the company's or trust's (nature of person H, SARS PAYE Employer `
    + 'Reconciliation BRS V25.3.0 p. 17), and it needs the entity\'s trading name and income tax reference (starting with 9). '
    + 'Add them on the employee\'s Work card, and the e@syFile file carries it.';
}

/**
 * H2: a tax status moved into or out of PSP in a tax year that already has runs for the employee: final ones, or one
 * calculated and not yet approved (review G). Not refused (the filings split the year per line), but named: earlier
 * approved months keep their treatment (a reopened one refuses to change it, PSP_STATUS_CHANGED_SINCE_APPROVAL), a month
 * not yet approved is recalculated WHOLE under the new status, and the year's certificates split in two (a separate
 * certificate when the nature of person changes, SARS BRS V25.3.0 p. 17). Null otherwise.
 */
export async function pspSwitchWarning(
  companyId: string, employeeId: string, before: string | null, after: string | null, today = new Date(),
): Promise<string | null> {
  const psp = 'personal_service_provider';
  if (before === after || (before !== psp && after !== psp)) return null;
  const taxYear = payeTaxYearOf(today.getMonth() + 1, today.getFullYear());
  const { start, end } = payeTaxYearBounds(taxYear);
  const rows = (await sql`
    SELECT count(DISTINCT h.id) FILTER (WHERE ${sql.unsafe(payRunFinalSql('h'))})::int AS final_runs,
           count(DISTINCT h.id) FILTER (WHERE h.status = 'calculated')::int AS open_runs
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
     WHERE h.company_id = ${companyId}::uuid AND l.employee_id = ${employeeId}::uuid
       AND make_date(h.period_year, h.period_month, 1) BETWEEN ${start}::date AND ${end}::date
  `) as DbRow[];
  const finalRuns = Number(rows[0]?.final_runs ?? 0);
  const openRuns = Number(rows[0]?.open_runs ?? 0);
  if (finalRuns === 0 && openRuns === 0) return null;
  return `The tax status moved ${after === psp ? 'to' : 'from'} personal service provider in the ${taxYear - 1}/${taxYear} tax year, `
    + `which already has ${finalRuns} final and ${openRuns} calculated run(s) for this person. Earlier months keep how they were taxed `
    + '(a reopened month refuses to recalculate under the new status). A month not yet approved is recalculated whole under the new '
    + 'status: a part-month split needs two employee records. The year\'s filings split per month into a natural person\'s certificate '
    + 'and the PSP\'s (a separate certificate, SARS PAYE Employer Reconciliation BRS V25.3.0 p. 17).';
}

/**
 * Round 3: a PSP's entity type changed (company <-> trust) in a tax year whose final runs carry PSP lines at the other
 * entity. Not refused, but named: those months keep the rate they were approved at, and a reopen of one refuses to
 * recalculate it at the new entity (PSP_STATUS_CHANGED_SINCE_APPROVAL). Null when no such month exists.
 */
export async function pspEntityChangeWarning(
  companyId: string, employeeId: string, before: string | null, after: string | null, today = new Date(),
): Promise<string | null> {
  if (!before || !after || before === after) return null;
  const taxYear = payeTaxYearOf(today.getMonth() + 1, today.getFullYear());
  const { start, end } = payeTaxYearBounds(taxYear);
  const rows = (await sql`
    SELECT DISTINCT h.period_year, h.period_month
      FROM payroll_run_lines l
      JOIN payroll_run_headers h ON h.id = l.run_id
     WHERE h.company_id = ${companyId}::uuid AND l.employee_id = ${employeeId}::uuid
       AND ${sql.unsafe(payRunFinalSql('h'))}
       AND make_date(h.period_year, h.period_month, 1) BETWEEN ${start}::date AND ${end}::date
       AND l.validation_results @> ${pspLineFlag}::jsonb
       AND NOT l.validation_results @> ${JSON.stringify([{ code: 'PAYE_OUTSIDE_TABLES', treatment: 'flat_psp', psp: { entity: after } }])}::jsonb
     ORDER BY h.period_year, h.period_month
  `) as DbRow[];
  if (rows.length === 0) return null;
  const months = rows.map((r) => formatDisplayMonthYearLong(new Date(Number(r.period_year), Number(r.period_month) - 1, 1)));
  return `The personal service provider's entity moved from ${before} to ${after}. ${months.join(', ')} ${months.length === 1 ? 'was' : 'were'} `
    + `approved as a ${before} and keep${months.length === 1 ? 's' : ''} that rate; a reopen of ${months.length === 1 ? 'it' : 'any of them'} `
    + `refuses to recalculate it as a ${after}. If the entity was recorded wrongly: set it back, recalculate, and correct it in the current month.`;
}
