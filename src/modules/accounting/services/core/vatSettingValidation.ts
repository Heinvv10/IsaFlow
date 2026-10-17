/**
 * Accepted values of the company VAT pair (`vat_period`, `vat_system_type`),
 * shared by /api/accounting/companies and /api/onboarding/complete-setup.
 */

/**
 * `vat_period` is free text in the schema and is read by the VAT signals via
 * normalizeVatSetting, which silently treats anything unrecognised as
 * bi-monthly. Reject junk at the door instead of filing VAT201 reminders for a
 * company whose cadence was a typo. 'none' = not a VAT vendor.
 */
const VALID_VAT_PERIODS = ['monthly', 'bi-monthly', 'none'];
export function isValidVatPeriod(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'string' && VALID_VAT_PERIODS.includes(value.trim().toLowerCase());
}

/**
 * `vat_system_type` is the other half of the pair — it is the column
 * `normalizeVatSetting` reads for the 'none' (not-a-VAT-vendor) flag. An
 * unrecognised value there reads as "registered", so junk must be rejected
 * here too or the two columns silently disagree.
 */
const VALID_VAT_SYSTEM_TYPES = ['invoice', 'payment', 'none'];
export function isValidVatSystemType(value: unknown): boolean {
  if (value === undefined || value === null || value === '') return true;
  return typeof value === 'string' && VALID_VAT_SYSTEM_TYPES.includes(value.trim().toLowerCase());
}

/** The stored form of an accepted value: trimmed and lower-case ('MONTHLY ' -> 'monthly'); empty -> undefined. */
export function normaliseVatSetting(value: string | undefined): string | undefined {
  const v = value?.trim().toLowerCase();
  return v || undefined;
}
