/**
 * Code 3230 for IRP3(b) fixed-percentage and IRP3(c) fixed-amount directives on an IRP5/IT3(a) (wave 5 DR).
 *
 * BRS V25.3.0 (PAYE Employer Reconciliation) p. 41-42, "Directive Information": "For fixed PAYE rate/amount directives,
 * ONLY the directive number MUST be completed"; from transaction year 2022 they are written as "3230,directive no,
 * 3230,directive no"; code 3230 is AN15 and "If Transaction Year is >= 2022, then Directive Number can be repeated up to
 * 5 times". The numbers are the ones the year's approved or paid lines were taxed by (PAYE_OUTSIDE_TABLES, treatment
 * 'directive', `directive.number`), read from the stored lines, never from the directive's live status. Company-scoped.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { EMP201_DECLARABLE_STATUSES } from '@/lib/constants/payrollRunStatuses';
import { PAYE_OUTSIDE_TABLES } from './taxStatusTreatment';
import { formatField, UsageError } from './easyFileFields';

/** BRS V25.3.0 p. 42: from 2022, at most 5 directive numbers on one certificate. */
export const MAX_DIRECTIVE_NUMBERS = 5;

/** By employee id: the distinct directive numbers of the year's declarable lines taxed by a regular-pay directive, in first-use order. */
export async function listRegularDirectiveNumbers(
  companyId: string, bounds: { start: string; end: string }, employeeId: string | null = null,
): Promise<Map<string, string[]>> {
  const declarable: string[] = [...EMP201_DECLARABLE_STATUSES];
  const rows = (await sql`
    SELECT l.employee_id, v->'directive'->>'number' AS number, MIN(make_date(h.period_year, h.period_month, 1)) AS first_used
    FROM payroll_run_lines l
    JOIN payroll_run_headers h ON h.id = l.run_id
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(l.validation_results, '[]'::jsonb)) v
    WHERE h.company_id = ${companyId}::uuid
      AND h.status = ANY(${declarable}::text[])
      AND make_date(h.period_year, h.period_month, 1) BETWEEN ${bounds.start}::date AND ${bounds.end}::date
      AND (${employeeId}::uuid IS NULL OR l.employee_id = ${employeeId}::uuid)
      AND v->>'code' = ${PAYE_OUTSIDE_TABLES} AND v->>'treatment' = 'directive'
    GROUP BY l.employee_id, v->'directive'->>'number'
    ORDER BY l.employee_id, first_used, number
  `) as DbRow[];
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(String(r.employee_id)) ?? [];
    list.push(r.number == null ? '' : String(r.number).trim());
    out.set(String(r.employee_id), list);
  }
  return out;
}

/** The certificate's 3230 lines for its regular-pay directives, refused (UsageError) when one cannot be written. */
export function regularDirectiveFieldLines(numbers: string[] | undefined, lumpSumDirectives: number, who: string): string[] {
  const list = numbers ?? [];
  for (const n of list) {
    if (!/^[A-Za-z0-9]{1,15}$/.test(n) || /^0+$/.test(n)) {
      throw new UsageError(`${who} was taxed under a fixed-percentage or fixed-amount directive whose number "${n}" cannot go on the certificate `
        + '(code 3230: up to 15 letters or digits, not zeros; BRS V25.3.0 p. 41). Correct the directive number and recalculate the runs it taxed.');
    }
  }
  if (list.length + lumpSumDirectives > MAX_DIRECTIVE_NUMBERS) {
    throw new UsageError(`${who} has ${list.length + lumpSumDirectives} directive numbers this year, and a certificate takes at most `
      + `${MAX_DIRECTIVE_NUMBERS} (BRS V25.3.0 p. 42). File this certificate by hand on e@syFile.`);
  }
  return list.map(n => formatField(3230, n, 'AN')).filter((l): l is string => l != null);
}
