/**
 * The one spelling of an employee-portal address (wave 6 SS, review #1570 M1/M2). Pure, no DB.
 *
 * Trim, NFKC, lowercase; anything left that is not plain ASCII is refused (null). The login route keys the
 * per-address brute-force bucket on this value and the lookup compares `a.email = $1` with the same value, so no
 * spelling can reach a login without charging its bucket. (JS toLowerCase and Postgres lower() disagree outside ASCII:
 * U+0130 'İ' is 'i̇' in JS and 'i' in PG, which opened a fresh bucket per spelling.) The invite stores this value, and
 * the login, accept and session checks require it to equal `lower(payroll_employees.email)`: the address on file now.
 */
// eslint-disable-next-line no-control-regex
const NON_ASCII = /[^\x00-\x7f]/;

export function normalisePortalEmail(raw: string): string | null {
  const v = raw.trim().normalize('NFKC').toLowerCase();
  return v === '' || NON_ASCII.test(v) ? null : v;
}
