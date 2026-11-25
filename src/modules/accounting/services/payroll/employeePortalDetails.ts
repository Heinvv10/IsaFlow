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
import { addressFromRow } from './payrollEmployeeAddress';
import type { EmployeeAddress } from './payrollEmployeeAddressInput';

export interface PortalBankSummary { bankName: string; accountLast4: string }

export interface PortalDetails {
  employeeName: string;
  employeeNumber: string;
  employer: string;
  address: EmployeeAddress | null;
  bank: PortalBankSummary | null;
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
  const bank = await migrationAdminTx('employee portal bank summary', async (client) => (await client.query<{ bank_name: string; last4: string }>(
    `SELECT bank_name, right(account_number, 4) AS last4
       FROM payroll_bank_details
      WHERE company_id = $1::uuid AND employee_id = $2::uuid AND is_active`,
    [companyId, employeeId],
  )).rows[0]);
  return {
    employeeName: `${String(row.first_name ?? '')} ${String(row.last_name ?? '')}`.trim(),
    employeeNumber: String(row.employee_number), employer: String(row.employer),
    address: addressFromRow(row),
    bank: bank ? { bankName: bank.bank_name, accountLast4: bank.last4 } : null,
  };
}
