/**
 * Pure VAT-period derivation — the single source of truth for SA VAT cycle
 * semantics (used by the bureau cockpit signals, the compliance calendar and
 * the VAT201 page's quick-period buttons).
 *
 * `companies.vat_period_alignment` records which month-number parity a
 * vendor's bi-monthly period ENDS on, per SARS:
 *   'odd'  = Category A — periods end Jan/Mar/May/Jul/Sep/Nov
 *   'even' = Category B — periods end Feb/Apr/Jun/Aug/Oct/Dec
 * Each bi-monthly period spans two calendar months. Monthly (Category C)
 * vendors are driven by `companies.vat_period` instead — alignment is
 * irrelevant for them. Returns are due by the 25th of the month following
 * the period end.
 *
 * A company that is NOT a VAT vendor is recorded by `vat_system_type = 'none'`
 * (mig 245 — the "No VAT" option in company settings). `vat_period = 'none'`
 * is accepted as an equivalent because the onboarding wizard writes the
 * cadence field; either value means the same thing, so a company can never be
 * half-registered. `normalizeVatSetting` is the only way in: it returns 'none'
 * for such rows, so every caller is forced by the type system to decide what a
 * non-vendor sees before it can reach a cadence-taking function.
 *
 * Legacy rows store cadence with mixed casing ('Bi-Monthly'); always go
 * through the normalizers.
 */
export type VatAlignment = 'odd' | 'even';
/** Filing cadence of a registered VAT vendor. */
export type VatCadence = 'monthly' | 'bi-monthly';
/** Stored VAT setting — a cadence, or 'none' for a non-vendor. */
export type VatSetting = VatCadence | 'none';

export interface VatPeriod {
  /** YYYY-MM-DD, first day of the period. */
  periodStart: string;
  /** YYYY-MM-DD, last day of the period (a month of the requested parity). */
  periodEnd: string;
  /** YYYY-MM-DD, 25th of the month after periodEnd. */
  dueDate: string;
}

export interface VatQuickPeriod {
  label: string;
  /** YYYY-MM-DD */
  from: string;
  /** YYYY-MM-DD */
  to: string;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function isNone(raw: string | null | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  return v === 'none' || v === 'not-registered' || v === 'not registered' || v === 'n/a';
}

/**
 * Normalise a company's stored VAT configuration.
 *
 * NULL/'' means "never configured", which for an SA business defaults to the
 * bi-monthly Category A cycle — the pre-existing behaviour, deliberately kept
 * so existing companies are unaffected. Opting out is always explicit.
 *
 * @param vatPeriod - `companies.vat_period` ('monthly' | 'bi-monthly' | 'none').
 * @param vatSystemType - `companies.vat_system_type` ('invoice' | 'payment' | 'none').
 *   Optional so callers that only hold the cadence still compile; pass it
 *   wherever the column is available.
 */
export function normalizeVatSetting(
  vatPeriod: string | null | undefined,
  vatSystemType?: string | null,
): VatSetting {
  if (isNone(vatSystemType) || isNone(vatPeriod)) return 'none';
  return vatPeriod?.trim().toLowerCase() === 'monthly' ? 'monthly' : 'bi-monthly';
}

/**
 * Accounting basis a registered vendor accounts for VAT on. Only meaningful
 * when isVatRegistered() is true — callers must check that first, because
 * 'none' normalises to 'invoice' here rather than inventing a third basis.
 */
export type VatBasis = 'invoice' | 'payment';

/** Narrow a stored `companies.vat_system_type` to a basis, defaulting to invoice. */
export function normalizeVatBasis(vatSystemType: string | null | undefined): VatBasis {
  return vatSystemType?.trim().toLowerCase() === 'payment' ? 'payment' : 'invoice';
}

/** False only when the company has explicitly opted out of VAT. */
export function isVatRegistered(
  vatPeriod: string | null | undefined,
  vatSystemType?: string | null,
): boolean {
  return normalizeVatSetting(vatPeriod, vatSystemType) !== 'none';
}

export function normalizeVatAlignment(raw: string | null | undefined): VatAlignment {
  return raw?.toLowerCase() === 'even' ? 'even' : 'odd';
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function isoYmd(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Last calendar day of month m (1..12) in year y — leap-aware. */
function lastDayOf(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/**
 * Most recent fully-ended VAT period as of `asOf` — the period the
 * cockpit's "VAT due" signal expects a return for.
 *
 * @param asOf - The reference instant. Only UTC year/month/day fields are read.
 *   `new Date()` is safe; avoid Dates built from local-midnight strings without a 'Z'.
 */
export function expectedVatPeriodAsOf(
  alignment: VatAlignment,
  asOf: Date,
  cadence: VatCadence = 'bi-monthly',
): VatPeriod {
  const wantOddEnd = alignment === 'odd';
  let y = asOf.getUTCFullYear();
  let m = asOf.getUTCMonth() + 1; // 1..12

  for (let i = 0; i < 13; i++) {
    const lastDay = new Date(Date.UTC(y, m, 0)); // day 0 of month m+1 = last day of month m
    const parityOdd = m % 2 === 1;
    const endsHere = cadence === 'monthly' || parityOdd === wantOddEnd;
    if (endsHere && lastDay.getTime() <= asOf.getTime()) {
      const startMonthsBack = cadence === 'monthly' ? 1 : 2;
      const periodStart = new Date(Date.UTC(y, m - startMonthsBack, 1));
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

/**
 * The filing periods that END in `year`, for the VAT201 page's quick-period
 * buttons. Bi-monthly 'odd' (Cat A) therefore starts at Dec(year-1)–Jan(year).
 */
export function vatQuickPeriods(year: number, cadence: VatCadence, alignment: VatAlignment): VatQuickPeriod[] {
  if (cadence === 'monthly') {
    return Array.from({ length: 12 }, (_, i) => {
      const m = i + 1;
      return {
        label: `${MONTHS[m - 1]} ${year}`,
        from: isoYmd(year, m, 1),
        to: isoYmd(year, m, lastDayOf(year, m)),
      };
    });
  }
  const endMonths = alignment === 'odd' ? [1, 3, 5, 7, 9, 11] : [2, 4, 6, 8, 10, 12];
  return endMonths.map((em) => {
    const startYear = em === 1 ? year - 1 : year;
    const sm = em === 1 ? 12 : em - 1;
    return {
      label: `${MONTHS[sm - 1]}–${MONTHS[em - 1]} ${startYear !== year ? `${startYear}/${year}` : year}`,
      from: isoYmd(startYear, sm, 1),
      to: isoYmd(year, em, lastDayOf(year, em)),
    };
  });
}

/** The quick period containing `asOf` (UTC date), crossing year boundaries when needed. */
export function defaultVatQuickPeriod(cadence: VatCadence, alignment: VatAlignment, asOf: Date): VatQuickPeriod {
  const today = iso(asOf);
  const year = asOf.getUTCFullYear();
  const candidates = [...vatQuickPeriods(year, cadence, alignment), ...vatQuickPeriods(year + 1, cadence, alignment)];
  return candidates.find((p) => p.from <= today && p.to >= today) ?? candidates[0]!;
}
