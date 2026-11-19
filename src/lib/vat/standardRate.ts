/**
 * The South African standard VAT rate, in percent. One definition for code that needs the statutory
 * rate itself (the bank VAT-inclusive split, the platform's own billing invoices); update it if SARS
 * changes the rate. Code that decides a tenant's VAT claim must still go through its guard
 * (scripts/ci/vatGuardAllowlist.ts), not read this directly.
 */
export const SA_STANDARD_VAT_RATE_PCT = 15;

/**
 * The standard rate by the day it took effect, oldest first. A document is rated by ITS date, so one
 * dated before a change keeps the rate that applied then. A new rate is a new row here and the constant
 * above (vatLineAmounts.test.ts holds the two together).
 */
const SA_STANDARD_VAT_RATES: ReadonlyArray<{ from: string; pct: number }> = [
  { from: '1991-09-30', pct: 10 },
  { from: '1993-04-07', pct: 14 },
  { from: '2018-04-01', pct: 15 },
];

/** A document date no rate can be read for; a route answers it 400. */
export class VatRateDateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VatRateDateError';
  }
}

const pad = (n: number): string => String(n).padStart(2, '0');

/** The standard rate in force on `date`: a 'YYYY-MM-DD…' string, or a Date read by its local calendar day. */
export function standardVatRatePctOn(date: string | Date): number {
  const day = date instanceof Date
    ? `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    : date.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    throw new VatRateDateError(`${JSON.stringify(day)} is not a calendar day`);
  }
  const row = SA_STANDARD_VAT_RATES.filter((r) => r.from <= day).pop();
  if (!row) throw new VatRateDateError(`${day} is before VAT began (${SA_STANDARD_VAT_RATES[0]!.from})`);
  return row.pct;
}
