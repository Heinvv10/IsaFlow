/**
 * What a directive create body must say (wave 5 DR). Pure; the route answers a problem as a 400 before anything is read
 * or written.
 *
 * Every type (`directiveBodyProblem`):
 * - `directive_number` at most 50 characters and `sars_reference` at most 100 (the columns, migration 310);
 * - `effective_date` / `expiry_date`, when sent, real YYYY-MM-DD dates from 2000 to 2100 ("" is refused, not a 500);
 * - `tax_rate`, when sent, a fraction 0..1 with at most 4 decimals (NUMERIC(5,4): never rounded silently).
 * A regular-pay directive (`regularPayDirectiveBodyProblem`; IRP3(b) fixed percentage, IRP3(c) fixed amount):
 * - fixed_percentage: `tax_rate` above 0 (a 0% directive would certify no tax), no `tax_amount`;
 * - fixed_amount: `tax_amount` above 0 with at most 2 decimals (rands a period), no `tax_rate`;
 * - `amount` is not used (stored 0, taxDirectiveKinds): absent or 0;
 * - `directive_number` REQUIRED, up to 15 letters or digits, not zeros: BRS V25.3.0 p. 41 (code 3230) "For fixed PAYE
 *   rate/amount directives, ONLY the directive number MUST be completed", AN15 (easyFileRegularDirectives);
 * - `expiry_date`, if given, on or after `effective_date` (blank = the tax year's end, G21 p. 15), and not past the end of the
 *   NEXT tax year (Hein, #1266: taxDirectiveOverlap.expiryPastCeilingProblem, also judged at approve).
 */
import { expiryPastCeilingProblem } from './taxDirectiveOverlap';
const isNumeric = (v: unknown): boolean =>
  (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)));
/** Decimal places as written in plain notation; an exponent form counts as too many. */
const decimals = (v: unknown): number => {
  const text = String(Number(v));
  return /e/i.test(text) ? 99 : (text.split('.')[1] ?? '').length;
};

/** A real calendar date in YYYY-MM-DD from 2000 to 2100 (2026-02-30 is not). */
export function isCalendarDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && y >= 2000 && y <= 2100;
}

/** BRS V25.3.0 p. 41, code 3230: AN15, not zeros. */
export const isCertificateDirectiveNumber = (v: unknown): v is string =>
  typeof v === 'string' && /^[A-Za-z0-9]{1,15}$/.test(v) && !/^0+$/.test(v);

export function directiveBodyProblem(body: {
  directive_number?: unknown; sars_reference?: unknown; tax_rate?: unknown; effective_date?: unknown; expiry_date?: unknown;
}): string | null {
  if (typeof body.directive_number === 'string' && body.directive_number.length > 50) return 'directive_number must be at most 50 characters';
  if (typeof body.sars_reference === 'string' && body.sars_reference.length > 100) return 'sars_reference must be at most 100 characters';
  for (const k of ['effective_date', 'expiry_date'] as const) {
    if (body[k] !== undefined && body[k] !== null && !isCalendarDate(body[k])) return `${k} must be a date in YYYY-MM-DD format from 2000 to 2100`;
  }
  if (body.tax_rate != null) {
    if (!isNumeric(body.tax_rate) || Number(body.tax_rate) < 0 || Number(body.tax_rate) > 1) return 'tax_rate must be a fraction between 0 and 1 (0.18 = 18%)';
    if (decimals(body.tax_rate) > 4) return 'tax_rate takes at most 4 decimals (0.1825 = 18.25%)';
  }
  return null;
}

export function regularPayDirectiveBodyProblem(body: {
  directive_type: 'fixed_percentage' | 'fixed_amount';
  amount?: unknown; tax_rate?: unknown; tax_amount?: unknown; effective_date?: unknown; expiry_date?: unknown; directive_number?: unknown;
}): string | null {
  const given = (v: unknown) => v !== undefined && v !== null && v !== '';
  if (given(body.amount) && !(isNumeric(body.amount) && Number(body.amount) === 0)) {
    return 'amount is not used by a fixed-percentage or fixed-amount directive: leave it out (SARS states a rate or a tax amount on an IRP3(b) / IRP3(c))';
  }
  if (body.directive_type === 'fixed_percentage') {
    if (given(body.tax_amount)) return 'tax_amount is for a fixed-amount directive: a fixed-percentage directive takes tax_rate only';
    if (!isNumeric(body.tax_rate) || Number(body.tax_rate) <= 0 || Number(body.tax_rate) > 1) {
      return 'tax_rate is required for a fixed-percentage directive: a fraction above 0 and at most 1 (0.2 = 20%)';
    }
  } else {
    if (given(body.tax_rate)) return 'tax_rate is for a fixed-percentage directive: a fixed-amount directive takes tax_amount only';
    if (!isNumeric(body.tax_amount) || Number(body.tax_amount) <= 0 || Number(body.tax_amount) >= 1e12 || decimals(body.tax_amount) > 2) {
      return 'tax_amount is required for a fixed-amount directive: the PAYE a month it directs, above R0, in rands and cents';
    }
  }
  if (!isCertificateDirectiveNumber(body.directive_number)) {
    return 'directive_number is required for a fixed-percentage or fixed-amount directive: up to 15 letters or digits, not zeros, as SARS issued it (it goes on the IRP5, code 3230)';
  }
  if (!isCalendarDate(body.effective_date)) return 'effective_date must be a date in YYYY-MM-DD format from 2000 to 2100';
  if (given(body.expiry_date) && String(body.expiry_date) < body.effective_date) return 'expiry_date must be on or after effective_date';
  return expiryPastCeilingProblem(body.effective_date, given(body.expiry_date) ? String(body.expiry_date) : null);
}
