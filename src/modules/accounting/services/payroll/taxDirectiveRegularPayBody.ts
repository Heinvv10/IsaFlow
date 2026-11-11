/**
 * What a create body must say for a regular-pay directive (IRP3(b) fixed percentage, IRP3(c) fixed amount; wave 5 DR).
 * Pure; the route answers a problem as a 400 before anything is read or written.
 *
 * - fixed_percentage: `tax_rate` (a fraction, 0.2 = 20%), no `tax_amount`.
 * - fixed_amount: `tax_amount` (rands of PAYE a period), no `tax_rate`.
 * - `amount` is not used (stored 0, taxDirectiveKinds): absent or 0.
 * - `effective_date` a real YYYY-MM-DD; `expiry_date`, if given, a real date on or after it (blank = the tax year's end,
 *   G21 p. 15).
 */
const isNumeric = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));

/** A real calendar date in YYYY-MM-DD (2026-02-30 is not). */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 2000;
}

export function regularPayDirectiveBodyProblem(body: {
  directive_type: 'fixed_percentage' | 'fixed_amount';
  amount?: unknown; tax_rate?: unknown; tax_amount?: unknown; effective_date?: unknown; expiry_date?: unknown;
}): string | null {
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  if (given(body.amount) && !(isNumeric(body.amount) && Number(body.amount) === 0)) {
    return 'amount is not used by a fixed-percentage or fixed-amount directive: leave it out (SARS states a rate or a tax amount on an IRP3(b) / IRP3(c))';
  }
  if (body.directive_type === 'fixed_percentage') {
    if (given(body.tax_amount)) return 'tax_amount is for a fixed-amount directive: a fixed-percentage directive takes tax_rate only';
    if (!isNumeric(body.tax_rate) || Number(body.tax_rate) < 0 || Number(body.tax_rate) > 1) {
      return 'tax_rate is required for a fixed-percentage directive: a fraction between 0 and 1 (0.2 = 20%)';
    }
  } else {
    if (given(body.tax_rate)) return 'tax_rate is for a fixed-percentage directive: a fixed-amount directive takes tax_amount only';
    if (!isNumeric(body.tax_amount) || Number(body.tax_amount) < 0 || Number(body.tax_amount) > 1e12) {
      return 'tax_amount is required for a fixed-amount directive: the PAYE a month it directs, R0 or more';
    }
  }
  if (!isCalendarDate(body.effective_date)) return 'effective_date must be a date in YYYY-MM-DD format';
  if (given(body.expiry_date)) {
    if (!isCalendarDate(body.expiry_date)) return 'expiry_date must be a date in YYYY-MM-DD format';
    if (body.expiry_date < body.effective_date) return 'expiry_date must be on or after effective_date';
  }
  return null;
}
