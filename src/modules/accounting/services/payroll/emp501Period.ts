/**
 * The two EMP501 reconciliation periods of a PAYE tax year (wave 6 EFb). Tax year Y runs 1 March Y-1 to the end of
 * February Y. The interim reconciliation covers March to August (Y-1), period code MM 08; the annual one the whole
 * year, MM 02 (SARS BRS PAYE Employer Reconciliation V25.3.0, code 2031 "CCYYMM, MM = 02 or 08"; certificate number
 * positions 15-16 the same MM). CCYY is the transaction year (code 2030, the tax year) for both.
 */
import { payeTaxYearBounds } from '@/modules/accounting/utils/payeTaxYear';

export type Emp501Kind = 'interim' | 'annual';

export interface Emp501Period {
  taxYear: number;
  kind: Emp501Kind;
  /** YYYY-MM-DD, inclusive. */
  start: string;
  end: string;
  /** The reconciliation month code: 8 (interim) or 2 (annual). */
  mm: 2 | 8;
  startYear: number;
  startMonth: number;
  endYear: number;
  endMonth: number;
}

export function emp501Period(taxYear: number, kind: Emp501Kind): Emp501Period {
  const year = payeTaxYearBounds(taxYear);
  if (kind === 'annual') {
    return { taxYear, kind, start: year.start, end: year.end, mm: 2, startYear: taxYear - 1, startMonth: 3, endYear: taxYear, endMonth: 2 };
  }
  return { taxYear, kind, start: year.start, end: `${taxYear - 1}-08-31`, mm: 8, startYear: taxYear - 1, startMonth: 3, endYear: taxYear - 1, endMonth: 8 };
}

/** The EMP501 period these dates are exactly, or null (any other window is not an EMP501). */
export function emp501PeriodOf(periodStart: string, periodEnd: string): Emp501Period | null {
  const m = /^(\d{4})-03-01$/.exec(periodStart);
  if (!m) return null;
  const taxYear = Number(m[1]) + 1;
  for (const kind of ['interim', 'annual'] as const) {
    const p = emp501Period(taxYear, kind);
    if (p.end === periodEnd) return p;
  }
  return null;
}

/** The CCYYMM reconciliation period (code 2031). */
export function reconciliationPeriodCode(p: Emp501Period): number {
  return Number(`${p.taxYear}${String(p.mm).padStart(2, '0')}`);
}
