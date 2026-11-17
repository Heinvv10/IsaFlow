/**
 * What stops an EMP501 being finalised (wave 6 EFb): IRP5 pre-validation errors for the tax year (PV,
 * preValidateTaxYear: an error is a certificate e@syFile would reject), and a month of the period that has a pay run
 * but no filed EMP201. Read-only; the GET shows it and the finalise refuses on it before its first write.
 *
 * A month counts as filed when its EMP201 has a FILED lifecycle version (tax_return_versions), or a legacy submission
 * of the month that is submitted or accepted (filed before the lifecycle existed). A month with no live pay run needs
 * none here: a company not yet paying staff files no EMP201 this check could find.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { preValidateTaxYear } from '@/modules/accounting/services/payroll/preValidationService';
import type { Emp501Period } from '@/modules/accounting/services/payroll/emp501Period';
import { ReturnRefusal } from './returnVersionTypes';

export const EMP501_NOT_READY = 'EMP501_NOT_READY';

export interface Emp501Readiness {
  /** Pre-validation errors (warnings never block). */
  validationErrors: number;
  /** Names of the employees with an error, at most 10. */
  employeesWithErrors: string[];
  codeReleaseLoaded: boolean;
  /** YYYY-MM of every month with a live pay run and no filed EMP201, in order. */
  unfiledEmp201Months: string[];
  ready: boolean;
}

const NAMED = 10;

async function unfiledEmp201Months(companyId: string, p: Emp501Period): Promise<string[]> {
  const rows = (await sql`
    SELECT DISTINCT to_char(m.month, 'YYYY-MM') AS month
    FROM (
      SELECT make_date(h.period_year, h.period_month, 1) AS month
      FROM payroll_run_headers h
      WHERE h.company_id = ${companyId}::UUID AND h.status <> 'cancelled'
    ) m
    WHERE m.month BETWEEN ${p.start}::DATE AND ${p.end}::DATE
      AND NOT EXISTS (
        SELECT 1 FROM tax_return_versions v
        WHERE v.company_id = ${companyId}::UUID AND v.form_type = 'EMP201' AND v.status = 'filed' AND v.period_start = m.month)
      AND NOT EXISTS (
        SELECT 1 FROM sars_submissions s
        WHERE s.company_id = ${companyId}::UUID AND s.form_type = 'EMP201' AND s.status IN ('submitted', 'accepted')
          AND s.period_start <= m.month AND s.period_end >= (m.month + INTERVAL '1 month' - INTERVAL '1 day')::DATE)
    ORDER BY 1
  `) as DbRow[];
  return rows.map((r) => String(r.month));
}

export async function emp501Readiness(companyId: string, p: Emp501Period): Promise<Emp501Readiness> {
  const pv = await preValidateTaxYear(companyId, { taxYear: p.taxYear });
  const withErrors = (pv?.employees ?? []).filter((e) => e.severity === 'error');
  const unfiled = await unfiledEmp201Months(companyId, p);
  const validationErrors = pv?.errors ?? 0;
  return {
    validationErrors,
    employeesWithErrors: withErrors.slice(0, NAMED).map((e) => e.name),
    codeReleaseLoaded: pv?.codeReleaseLoaded ?? false,
    unfiledEmp201Months: unfiled,
    ready: validationErrors === 0 && unfiled.length === 0,
  };
}

/** 409 EMP501_NOT_READY naming what blocks it, or nothing. */
export async function assertEmp501Ready(companyId: string, p: Emp501Period): Promise<void> {
  const r = await emp501Readiness(companyId, p);
  if (r.ready) return;
  const parts: string[] = [];
  if (r.validationErrors > 0) {
    parts.push(`IRP5 pre-validation has ${r.validationErrors} error${r.validationErrors === 1 ? '' : 's'} `
      + `(${r.employeesWithErrors.join(', ')}${r.employeesWithErrors.length < r.validationErrors ? ', …' : ''})`
      + `${r.codeReleaseLoaded ? '' : '; no SARS source-code release is loaded for this tax year'}`);
  }
  if (r.unfiledEmp201Months.length > 0) parts.push(`the EMP201 for ${r.unfiledEmp201Months.join(', ')} is not filed`);
  throw new ReturnRefusal(409, `This EMP501 cannot be finalised: ${parts.join('; and ')}. Fix these first.`, EMP501_NOT_READY,
    { validationErrors: r.validationErrors, unfiledEmp201Months: r.unfiledEmp201Months });
}
