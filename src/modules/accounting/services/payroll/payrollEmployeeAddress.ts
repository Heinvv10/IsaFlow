/**
 * Reading and writing an employee's residential and postal address (wave 7 EA1, W5 part 1; migration 1056; Hein's
 * ruling 10: the payroll admin captures it, the portal shows it read-only, no self-service edit). The shape and the
 * SARS BRS checks are payrollEmployeeAddressInput.ts.
 *
 * Who: the route's withPayrollDetailAccess roles (owner / admin / manager), a person in their own session (Login-as and
 * tokens are refused there). Every query is bound to the company. The database records who changed what (888's
 * entity_change_capture on payroll_employees; the address keys are masked when the history is read:
 * entityChangeMasking.ts). The same address again writes nothing (the capture records no unchanged key). An address
 * is never logged: only the ids.
 */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { EmployeeAddress } from './payrollEmployeeAddressInput';

const str = (v: unknown): string | null => (v == null || v === '' ? null : String(v));

/** The stored address, or null when none has been captured (no residential street: 3214 is mandatory). */
export function addressFromRow(r: DbRow): EmployeeAddress | null {
  if (str(r.residential_street) === null) return null;
  const residential = {
    unitNumber: str(r.residential_unit_number), complex: str(r.residential_complex),
    streetNumber: str(r.residential_street_number), street: String(r.residential_street),
    suburb: str(r.residential_suburb), city: str(r.residential_city), postalCode: str(r.residential_postal_code),
    countryCode: str(r.residential_country_code) ?? 'ZA',
  };
  if (r.postal_same_as_residential !== false) return { residential, postal: { sameAsResidential: true } };
  return {
    residential,
    postal: {
      sameAsResidential: false, line1: String(r.postal_address_line1 ?? ''), line2: str(r.postal_address_line2),
      line3: str(r.postal_address_line3), line4: str(r.postal_address_line4), postalCode: str(r.postal_address_code),
      countryCode: str(r.postal_address_country_code) ?? 'ZA',
    },
  };
}

/** The employee's address: `undefined` when the company has no such employee, null when none is captured. */
export async function getEmployeeAddress(companyId: string, employeeId: string): Promise<EmployeeAddress | null | undefined> {
  const rows = (await sql`
    SELECT residential_unit_number, residential_complex, residential_street_number, residential_street,
           residential_suburb, residential_city, residential_postal_code, residential_country_code,
           postal_same_as_residential, postal_address_line1, postal_address_line2, postal_address_line3,
           postal_address_line4, postal_address_code, postal_address_country_code
      FROM payroll_employees
     WHERE company_id = ${companyId}::uuid AND id = ${employeeId}::uuid
  `) as DbRow[];
  return rows[0] ? addressFromRow(rows[0]) : undefined;
}

/**
 * Store the address, from parseEmployeeAddress's output (already checked: nothing is refused here but a missing
 * employee, which writes nothing). Postal = residential clears the postal lines. Returns the stored address, or
 * `undefined` when the company has no such employee.
 */
export async function setEmployeeAddress(companyId: string, employeeId: string, a: EmployeeAddress): Promise<EmployeeAddress | null | undefined> {
  const r = a.residential;
  const p = a.postal.sameAsResidential ? null : a.postal;
  const rows = (await sql`
    UPDATE payroll_employees SET
      residential_unit_number = ${r.unitNumber}, residential_complex = ${r.complex},
      residential_street_number = ${r.streetNumber}, residential_street = ${r.street},
      residential_suburb = ${r.suburb}, residential_city = ${r.city},
      residential_postal_code = ${r.postalCode}, residential_country_code = ${r.countryCode},
      postal_same_as_residential = ${p === null},
      postal_address_line1 = ${p?.line1 ?? null}, postal_address_line2 = ${p?.line2 ?? null},
      postal_address_line3 = ${p?.line3 ?? null}, postal_address_line4 = ${p?.line4 ?? null},
      postal_address_code = ${p?.postalCode ?? null}, postal_address_country_code = ${p?.countryCode ?? null},
      updated_at = NOW()
     WHERE company_id = ${companyId}::uuid AND id = ${employeeId}::uuid
    RETURNING residential_unit_number, residential_complex, residential_street_number, residential_street,
              residential_suburb, residential_city, residential_postal_code, residential_country_code,
              postal_same_as_residential, postal_address_line1, postal_address_line2, postal_address_line3,
              postal_address_line4, postal_address_code, postal_address_country_code
  `) as DbRow[];
  if (!rows[0]) return undefined;
  log.info('setEmployeeAddress', { companyId, employeeId });
  return addressFromRow(rows[0]);
}
