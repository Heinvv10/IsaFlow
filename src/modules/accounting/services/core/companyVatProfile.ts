/**
 * Pure half of the company VAT/tax profile change (MCP `update_company_profile`): the shapes, the validators and
 * the VAT-period boundaries a SARS category change would move. No database import.
 *
 * Storage (the settings page's own, companyService.updateCompany): `vat_number`, `tax_number` (the income tax
 * number), `vat_period` ('monthly' | 'bi-monthly' | 'none') and `vat_period_alignment` ('odd' | 'even'). The SARS
 * category is DERIVED, exactly as vatPeriodHelper documents it: C = monthly, A = bi-monthly ending in odd months,
 * B = bi-monthly ending in even months. Categories D and E (six-monthly, annual) are not representable.
 */
import {
  defaultVatQuickPeriod, normalizeVatAlignment, normalizeVatSetting,
  type VatAlignment, type VatCadence, type VatSetting,
} from '@/modules/bureau/services/vatPeriodHelper';

export type VatCategory = 'A' | 'B' | 'C';
export const VAT_CATEGORIES: readonly VatCategory[] = ['A', 'B', 'C'];
export const VAT_ALIGNMENTS: readonly VatAlignment[] = ['odd', 'even'];

/** What the company holds today (or would hold after the change). */
export interface VatProfileState {
  vatNumber: string | null;
  incomeTaxNumber: string | null;
  setting: VatSetting;
  alignment: VatAlignment;
}

/** The validated request: only the fields the caller sent. */
export interface VatProfileRequest {
  vatNumber?: string;
  incomeTaxNumber?: string;
  category?: VatCategory;
  alignment?: VatAlignment;
}

/** A SA VAT number: ten digits, the first a 4 (the rule the e-filing submission already applies). */
export function isValidSaVatNumber(value: string): boolean {
  return /^4\d{9}$/.test(value);
}

/** Spaces removed; the comparison and storage form of a tax number. */
export function compactNumber(value: string): string {
  return value.replace(/\s+/g, '');
}

/** The SARS category of a stored setting: 'none' for a non-vendor. */
export function categoryOf(setting: VatSetting, alignment: VatAlignment): VatCategory | 'none' {
  if (setting === 'none') return 'none';
  if (setting === 'monthly') return 'C';
  return alignment === 'even' ? 'B' : 'A';
}

export type Resolved = { error: string } | { cadence: VatCadence; alignment: VatAlignment };

/**
 * The cadence and alignment the company would have after the request, or the reason it cannot.
 * `vat_category` A/B/C names both at once; `vat_alignment` alone moves a bi-monthly company between A and B.
 */
export function resolveDesired(current: VatProfileState, req: VatProfileRequest): Resolved {
  const wantsCycle = req.category !== undefined || req.alignment !== undefined;
  if (current.setting === 'none') {
    return wantsCycle ? { error: 'The company is not registered for VAT, so it has no VAT category to change. Register it in Settings > VAT first.' }
      : { cadence: 'bi-monthly', alignment: current.alignment };
  }
  if (req.category === 'C') {
    if (req.alignment !== undefined) return { error: 'vat_alignment applies to bi-monthly (category A or B) only; category C is monthly.' };
    return { cadence: 'monthly', alignment: current.alignment };
  }
  if (req.category !== undefined) {
    const implied: VatAlignment = req.category === 'A' ? 'odd' : 'even';
    if (req.alignment !== undefined && req.alignment !== implied) {
      return { error: `vat_category ${req.category} is ${implied}-month alignment, but vat_alignment is ${req.alignment}.` };
    }
    return { cadence: 'bi-monthly', alignment: implied };
  }
  if (req.alignment !== undefined) {
    if (current.setting === 'monthly') {
      return { error: 'vat_alignment applies to a bi-monthly company; this one is monthly (category C). Send vat_category A or B to change it.' };
    }
    return { cadence: 'bi-monthly', alignment: req.alignment };
  }
  return { cadence: current.setting, alignment: current.alignment };
}

export interface Span { from: string; to: string }
export interface PeriodPair { current: Span; next: Span }
export interface PeriodImpact {
  /** The reference date the current and next periods are taken at. */
  as_of: string;
  changes_periods: boolean;
  /** The period containing as_of, and the one after it, under the old and the new cycle (null: not a VAT vendor). */
  current: { old: Span | null; new: Span | null };
  next: { old: Span | null; new: Span | null };
}

function span(p: { from: string; to: string }): Span {
  return { from: p.from, to: p.to };
}

/** The VAT period containing `asOf` and the one after it. */
export function periodsAround(cadence: VatCadence, alignment: VatAlignment, asOf: Date): PeriodPair {
  const current = defaultVatQuickPeriod(cadence, alignment, asOf);
  const dayAfter = new Date(Date.parse(`${current.to}T00:00:00Z`) + 86_400_000);
  return { current: span(current), next: span(defaultVatQuickPeriod(cadence, alignment, dayAfter)) };
}

const same = (a: Span | null, b: Span | null): boolean => a?.from === b?.from && a?.to === b?.to;

/** The current and next VAT periods before and after the change, and whether either moves. */
export function periodImpact(current: VatProfileState, desired: { cadence: VatCadence; alignment: VatAlignment }, asOf: Date): PeriodImpact {
  const old = current.setting === 'none' ? null : periodsAround(current.setting, current.alignment, asOf);
  const next = periodsAround(desired.cadence, desired.alignment, asOf);
  const impact: PeriodImpact = {
    as_of: asOf.toISOString().slice(0, 10),
    changes_periods: false,
    current: { old: old?.current ?? null, new: next.current },
    next: { old: old?.next ?? null, new: next.next },
  };
  impact.changes_periods = !same(impact.current.old, impact.current.new) || !same(impact.next.old, impact.next.new)
    || (current.setting !== 'none' && (current.setting !== desired.cadence
      || (desired.cadence === 'bi-monthly' && current.alignment !== desired.alignment)));
  return impact;
}

/** A company's stored columns as a profile state; the settings page's own normalisers do the reading. */
export function stateFromColumns(c: {
  vatNumber: string | null; taxNumber: string | null; vatPeriod: string | null | undefined;
  vatSystemType: string | null | undefined; vatPeriodAlignment: string | null | undefined;
}): VatProfileState {
  return {
    vatNumber: c.vatNumber, incomeTaxNumber: c.taxNumber,
    setting: normalizeVatSetting(c.vatPeriod, c.vatSystemType),
    alignment: normalizeVatAlignment(c.vatPeriodAlignment),
  };
}
