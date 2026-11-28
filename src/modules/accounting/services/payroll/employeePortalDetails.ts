/**
 * What the employee portal's "Your details" shows (wave 7 EA1, W5; Hein's ruling 10): the signed-in employee's own
 * address as the payroll admin captured it, and their bank account as the bank name and the last four digits of the
 * number. Read-only: there is no self-service edit; the employee asks their employer to change either.
 *
 * Keyed on the verified portal session's company and employee only (employeePortalAuth), never on the request.
 * The address is on payroll_employees, which the service pool reads (as `me` already does). payroll_bank_details is
 * on 915's exclusion list (952): no app_service policy, so the service pool reads no row of it. The bank line is read
 * on migration_admin (BYPASSRLS) by one fixed statement that returns the bank name and right(account_number, 4)
 * only: the full number, branch code and holder never leave the database on this path.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { log } from '@/lib/logger';
import { addressFromRow } from './payrollEmployeeAddress';
import type { EmployeeAddress } from './payrollEmployeeAddressInput';

export interface PortalBankSummary { bankName: string; accountLast4: string }

export interface PortalDetails {
  employeeName: string;
  employeeNumber: string;
  employer: string;
  address: EmployeeAddress | null;
  bank: PortalBankSummary | null;
  /** True when the bank line could not be read (migration_admin unreachable): `bank` is then null for that reason, not "none on record". */
  bankUnavailable: boolean;
}

/**
 * Degrade only when the database cannot answer (breaker #1932 round 2, review of 3485068fe0): no
 * MIGRATION_ADMIN_DATABASE_URL, a named socket failure, a pool connect timeout, a terminated connection, or a SQLSTATE in
 * the outage classes: 08 connection exception, 28 invalid authorization, 53 insufficient resources, 57 operator
 * intervention (57P01-57P03 shutdown / cannot connect now), 58 system error. Every other SQLSTATE (42 grant / RLS /
 * schema drift, 22 data, 23 constraint, XX internal) and every other code is a defect and is rethrown.
 */
const CONNECTION_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EPIPE']);
export function isBankReadUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === 'string' && (/^(08|28|53|57|58)[0-9A-Z]{3}$/.test(code) || CONNECTION_CODES.has(code))) return true;
  return /MIGRATION_ADMIN_DATABASE_URL required|timeout exceeded when trying to connect|Connection terminated/.test(err.message);
}

/** The employee's own details, or null when the session's employee is not that company's. */
export async function readPortalDetails(companyId: string, employeeId: string): Promise<PortalDetails | null> {
  const row = ((await sql`
    SELECT e.first_name, e.last_name, e.employee_number, c.name AS employer,
           e.residential_unit_number, e.residential_complex, e.residential_street_number, e.residential_street,
           e.residential_suburb, e.residential_city, e.residential_postal_code, e.residential_country_code,
           e.postal_same_as_residential, e.postal_address_line1, e.postal_address_line2, e.postal_address_line3,
           e.postal_address_line4, e.postal_address_code, e.postal_address_country_code
      FROM payroll_employees e JOIN companies c ON c.id = e.company_id
     WHERE e.id = ${employeeId}::uuid AND e.company_id = ${companyId}::uuid
  `) as DbRow[])[0];
  if (!row) return null;
  // Review #1932 M2: the bank line is the one read on migration_admin. If that pool cannot answer (URL unset, pool or
  // query error), the rest of the page still shows: logged by ids only, and said as unavailable, not as "none".
  let bank: { bank_name: string; last4: string } | undefined;
  let bankUnavailable = false;
  try {
    bank = await migrationAdminTx('employee portal bank summary', async (client) => (await client.query<{ bank_name: string; last4: string }>(
      `SELECT bank_name, right(account_number, 4) AS last4
         FROM payroll_bank_details
        WHERE company_id = $1::uuid AND employee_id = $2::uuid AND is_active`,
      [companyId, employeeId],
    )).rows[0]);
  } catch (err) {
    if (!isBankReadUnavailable(err)) throw err; // a defect, not an outage: the request fails as any other would
    bankUnavailable = true;
    log.warn('Employee portal: bank line unavailable', {
      companyId, employeeId, error: err instanceof Error ? err.name : 'unknown',
    }, 'employeePortalDetails');
  }
  return {
    employeeName: `${String(row.first_name ?? '')} ${String(row.last_name ?? '')}`.trim(),
    employeeNumber: String(row.employee_number), employer: String(row.employer),
    address: addressFromRow(row),
    bank: bank ? { bankName: bank.bank_name, accountLast4: bank.last4 } : null,
    bankUnavailable,
  };
}
