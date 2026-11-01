/**
 * What a payroll employee's fields may hold. No database import, so a page can use the same rules as the server;
 * irp5ValidationEngine re-exports the two validators, which is where callers have always found them.
 */
export function isValidSarsTaxNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^[01239]\d{9}$/.test(value.trim());
}

export function isValidSaIdNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  return /^\d{13}$/.test(value.trim());
}

/** payroll_employee_components.amount is NUMERIC(14,2). */
export const MAX_SALARY_CENTS = 99_999_999_999_999;
