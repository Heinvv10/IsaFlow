/**
 * One regular-pay directive (IRP3(b) / IRP3(c)) per employee per period (wave 5 DR).
 *
 * A directive "is only valid for the tax year or period stated thereon" (PAYE-GEN-01-G21 (2027) Rev 1 p. 15), so one in
 * force runs from its effective date to its expiry date or, with none, to the last day of the tax year (end of February)
 * its effective date falls in (`directiveEndsOnSql`, `directiveEndsOn`). A run reads the directive in force on the
 * period's last day (payrollRunRegularDirective), so two whose windows overlap would leave it to choose.
 *
 * Judged at CREATE (against the employee's pending and approved regular-pay directives) and at APPROVE (against the
 * approved ones), each under `pg_advisory_xact_lock` on (company, employee), taken before any row lock and before any
 * write: two concurrent creates or approves for one employee serialise, and the second sees the first's row. The
 * refusal (TaxDirectiveWindowError, a 400) is thrown before the request writes anything. A run approval takes no
 * advisory lock (it reads the rows FOR SHARE), so no lock cycle with it.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { underFlowLockBudget } from '@/modules/accounting/services/core/rowLockBudget';
import { REGULAR_PAY_DIRECTIVE_TYPES } from './taxDirectiveKinds';

/** A regular-pay directive's window refused (overlap, an approved period inside it, an expiry change): a 400, nothing written. */
export class TaxDirectiveWindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TaxDirectiveWindowError';
  }
}

/** The last day a stored directive (alias d) is in force: its expiry, else the end of its effective date's tax year. */
export const directiveEndsOnSql = (alias = 'd') => sql.unsafe(
  `COALESCE(${alias}.expiry_date, (make_date(EXTRACT(YEAR FROM ${alias}.effective_date)::int
     + CASE WHEN EXTRACT(MONTH FROM ${alias}.effective_date) >= 3 THEN 1 ELSE 0 END, 3, 1) - 1))`,
);

/** The same for a directive not stored yet, YYYY-MM-DD in and out. */
export function directiveEndsOn(effectiveDate: string, expiryDate: string | null): string {
  if (expiryDate) return expiryDate;
  const [y, m] = effectiveDate.split('-').map(Number) as [number, number];
  const endYear = m >= 3 ? y + 1 : y;
  const leap = (endYear % 4 === 0 && endYear % 100 !== 0) || endYear % 400 === 0;
  return `${endYear}-02-${leap ? '29' : '28'}`;
}

/** The end of the tax year after the one `effectiveDate` falls in (2026-03-01 -> 2028-02-29): the latest a regular-pay directive may run to. */
export function directiveCeiling(effectiveDate: string): string {
  const yearEnd = directiveEndsOn(effectiveDate, null);
  return directiveEndsOn(`${yearEnd.slice(0, 4)}-03-01`, null);
}

/**
 * Hein (#1266 adv2 L): a regular-pay directive's expiry may not pass directiveCeiling, at create and at approve (and so an
 * undo can never restore past it). The refusal names the limit; null when it is within.
 */
export function expiryPastCeilingProblem(effectiveDate: string, expiryDate: string | null): string | null {
  const ceiling = directiveCeiling(effectiveDate);
  if (expiryDate == null || expiryDate <= ceiling) return null;
  return `expiry_date ${expiryDate} is past ${ceiling}, the end of the tax year after the one the directive starts in (${effectiveDate}): `
    + 'a regular-pay directive may run to that date at most. SARS issues a new directive for a later period.';
}

/** Serialise every create and approve of one employee's regular-pay directives (bounded wait, a 503 on timeout). */
export async function lockEmployeeRegularDirectives(companyId: string, employeeId: string): Promise<void> {
  await underFlowLockBudget('This employee\'s tax directives', async () => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`tax_directive_regular_pay:${companyId}:${employeeId}`}, 0))`;
  });
}

/**
 * Throw TaxDirectiveWindowError when another of the employee's regular-pay directives with one of `statuses` is in force
 * on any day of [effectiveDate, endsOn]. Call under lockEmployeeRegularDirectives. Read-only.
 */
export async function assertNoRegularDirectiveOverlap(companyId: string, employeeId: string, window: {
  effectiveDate: string; endsOn: string; excludeId?: string; statuses: Array<'pending' | 'approved'>;
}): Promise<void> {
  const types: string[] = [...REGULAR_PAY_DIRECTIVE_TYPES];
  const clash = (await sql`
    SELECT d.directive_number, d.status, d.effective_date::text AS effective_date, (${directiveEndsOnSql('d')})::text AS ends_on
    FROM tax_directives d
    WHERE d.company_id = ${companyId}::uuid
      AND d.employee_id = ${employeeId}::uuid
      AND d.directive_type = ANY(${types}::text[])
      AND d.status = ANY(${window.statuses}::text[])
      AND (${window.excludeId ?? null}::uuid IS NULL OR d.id <> ${window.excludeId ?? null}::uuid)
      AND d.effective_date <= ${window.endsOn}::date
      AND ${directiveEndsOnSql('d')} >= ${window.effectiveDate}::date
    ORDER BY d.effective_date, d.id
    LIMIT 1
  `) as DbRow[];
  const other = clash[0];
  if (!other) return;
  throw new TaxDirectiveWindowError(
    `This employee already has ${other.status === 'approved' ? 'an approved' : 'a pending'} regular-pay directive${other.directive_number ? ` (${String(other.directive_number)})` : ''} `
    + `in force from ${String(other.effective_date)} to ${String(other.ends_on)}, which overlaps ${window.effectiveDate} to ${window.endsOn}. `
    + 'A period can be taxed by only one fixed-percentage or fixed-amount directive: cancel the other one, or give it an expiry date before this one starts.',
  );
}
