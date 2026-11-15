/**
 * The South African standard VAT rate, in percent. One definition for code that needs the statutory
 * rate itself (the bank VAT-inclusive split, the platform's own billing invoices); update it if SARS
 * changes the rate. Code that decides a tenant's VAT claim must still go through its guard
 * (scripts/ci/vatGuardAllowlist.ts), not read this directly.
 */
export const SA_STANDARD_VAT_RATE_PCT = 15;
