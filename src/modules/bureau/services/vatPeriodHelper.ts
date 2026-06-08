/**
 * Pure VAT-period derivation for the bureau cockpit's "VAT due" signal.
 *
 * SA VAT vendors file bi-monthly. `companies.vat_period_alignment` records
 * which month-number parity a vendor's period ENDS on: 'odd' = Category A
 * (periods end Jan/Mar/May/…), 'even' = Category B (Feb/Apr/…). Each period
 * spans two calendar months. Returns are due by the 25th of the month
 * following the period end.
 *
 * NOTE: monthly (Category C) vendors are out of scope this increment — the
 * column only encodes odd/even parity. Treating everyone as bi-monthly is the
 * documented simplification; refine if a monthly flag is added.
 */
export type VatAlignment = 'odd' | 'even';

export interface VatPeriod {
  /** YYYY-MM-DD, first day of the two-month period. */
  periodStart: string;
  /** YYYY-MM-DD, last day of the period (a month of the requested parity). */
  periodEnd: string;
  /** YYYY-MM-DD, 25th of the month after periodEnd. */
  dueDate: string;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * @param asOf - The reference instant. Only UTC year/month fields are read.
 *   `new Date()` is safe; avoid Dates built from local-midnight strings without a 'Z'.
 */
export function expectedVatPeriodAsOf(alignment: VatAlignment, asOf: Date): VatPeriod {
  const wantOddEnd = alignment === 'odd';
  let y = asOf.getUTCFullYear();
  let m = asOf.getUTCMonth() + 1; // 1..12

  for (let i = 0; i < 13; i++) {
    const lastDay = new Date(Date.UTC(y, m, 0)); // day 0 of month m+1 = last day of month m
    const parityOdd = m % 2 === 1;
    if (parityOdd === wantOddEnd && lastDay.getTime() <= asOf.getTime()) {
      const periodStart = new Date(Date.UTC(y, m - 2, 1)); // first day of the preceding month
      const dueMonth = m === 12 ? 1 : m + 1;
      const dueYear = m === 12 ? y + 1 : y;
      const dueDate = new Date(Date.UTC(dueYear, dueMonth - 1, 25));
      return { periodStart: iso(periodStart), periodEnd: iso(lastDay), dueDate: iso(dueDate) };
    }
    m -= 1;
    if (m === 0) { m = 12; y -= 1; }
  }
  throw new Error('expectedVatPeriodAsOf: no period found');
}
