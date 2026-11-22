/**
 * The new and edit invoice pages' per-line VAT. Each line carries its OWN VAT type (the platform list,
 * DOCUMENT_LINE_VAT_TYPES: standard, zero_rated, exempt); the rate is never the user's: it is the type's rate on the
 * invoice date (shared/vatTypes, lib/vat/standardRate). A line's type is:
 *   - the one the user picked, the one a scan read off the document, or the one it LOADED with on the edit page
 *     (`vatType` set: a mixed invoice round-trips, a legacy line keeps its own rate's type, editInvoiceLoad);
 *   - none yet (`vatType` null: a scanned or legacy rate that is neither the standard rate nor 0): the line asks for one
 *     and Create, Save and autosave hold until it has one (vatTypeProblem);
 *   - else (`vatType` absent) the server's default chain for the customer (invoiceLineVatTypes.defaultLineVatType: the
 *     customer's default_vat_type when zero-rated or exempt, else standard; the pages name no item), read at render, so
 *     it follows a customer picked or changed later. `vatFallback` replaces standard at the end of that chain for a
 *     legacy line loaded off a header that charged no VAT (it was zero-rated, or exempt for an exempt customer).
 * Prices are sent AS ENTERED with the mode (inclusive: VAT-inclusive), and the totals are the shared per-line pricing
 * (invoiceLineVatPricing.previewInvoiceVat), so the totals show the figure create and the draft edit store. A company
 * not registered for VAT prices at no VAT ('none'), its lines untyped, as the server forces it.
 *
 * Pure: safe in a client bundle (useTaxModeSwitch reads the active company's registration).
 */
import { isRatedDate, standardVatRatePctOn } from '@/lib/vat/standardRate';
import { previewInvoiceVat, type AmountsAre } from '@/modules/accounting/services/ar/invoiceLineVatPricing';
import { defaultLineVatType, type DocumentLineVatType } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import { DOCUMENT_LINE_VAT_TYPES, normaliseVatType, vatRatePctOn } from '@/modules/accounting/services/shared/vatTypes';
import type { TaxMode } from './taxMode';

export type LineVatType = DocumentLineVatType;
/** A line's resolved type; null = none yet (the line asks for one). */
export type LineVatTypeOrNone = LineVatType | null;

export interface FormVatLine {
  quantity: number; unitPrice: number; discount?: number;
  /** The line's own type (see the header): absent = the customer's default, null = none yet. */
  vatType?: string | null;
  /** The end of the default chain for this line instead of standard (a legacy line off a no-VAT header). */
  vatFallback?: 'zero_rated';
}

/** The mode the form prices and sends in: 'none' for a company not registered for VAT, whatever is picked; a registered
 * company prices by line, so an old 'none' (a draft kept before per-line VAT) reads as exclusive. */
export const vatModeFor = (registered: boolean, picked: TaxMode): TaxMode => (registered ? (picked === 'none' ? 'exclusive' : picked) : 'none');

/** What the server stores the prices as, for the form's mode. */
export const amountsAreFor = (mode: TaxMode): AmountsAre => (mode === 'inclusive' ? 'inclusive' : 'exclusive');

const isLineType = (t: unknown): t is LineVatType => typeof t === 'string' && (DOCUMENT_LINE_VAT_TYPES as readonly string[]).includes(t);

/** The type a stored or sent value names, read as the server reads it (legacy 'zero'), or null. */
export const asLineVatType = (v: unknown): LineVatTypeOrNone => {
  const t = normaliseVatType(typeof v === 'string' ? v.trim().toLowerCase() : v);
  return isLineType(t) ? t : null;
};

/** The server's default chain for the customer (invoiceLineVatTypes), `fallback` at its end instead of standard. */
export function customerLineVatType(customerVat: string | null | undefined, fallback: LineVatType = 'standard'): LineVatType {
  const t = defaultLineVatType({ customer: customerVat ?? null, item: null });
  return t === 'standard' ? fallback : t;
}

/** One line's type (see the header). */
export function lineVatType(line: Pick<FormVatLine, 'vatType' | 'vatFallback'>, customerVat?: string | null): LineVatTypeOrNone {
  if (line.vatType === null) return null;
  if (line.vatType !== undefined) return asLineVatType(line.vatType);
  return customerLineVatType(customerVat, line.vatFallback ?? 'standard');
}

/** Each line's type. */
export const lineVatTypes = (lines: readonly FormVatLine[], customerVat?: string | null): LineVatTypeOrNone[] =>
  lines.map((l) => lineVatType(l, customerVat));

/** The type a document's rate gives on `date`: 0 -> zero_rated, the standard rate -> standard, any other rate none (null). */
export function typeForRate(rate: number, date: string): LineVatTypeOrNone {
  if (rate === 0) return 'zero_rated';
  return isRatedDate(date) && rate === standardVatRatePctOn(date) ? 'standard' : null;
}

/** The percent a type carries on `date` (0 where the date has no rate yet, or the line no type). */
export const lineVatRate = (type: LineVatTypeOrNone, date: string): number => (type && isRatedDate(date) ? vatRatePctOn(type, date) : 0);

/** Why a save holds: a line (with something in it) that has no VAT type yet. */
export function vatTypeProblem(lines: readonly (FormVatLine & { description?: string })[], types: readonly LineVatTypeOrNone[]): string | null {
  const i = types.findIndex((t, k) => t === null && Boolean(lines[k]!.description || lines[k]!.unitPrice));
  if (i < 0) return null;
  const d = lines[i]!.description;
  return `Choose a VAT type for ${d ? `"${d}"` : `line ${i + 1}`}`;
}

/** The types priced: none for a company not registered for VAT; a line with no type yet previews with no VAT. */
const pricedTypes = (types: readonly LineVatTypeOrNone[], mode: TaxMode): LineVatType[] | null =>
  (mode === 'none' ? null : types.map((t) => t ?? 'zero_rated'));

/** The totals, `unitPrice` as entered in `mode` (see the header). */
export function formTotals(lines: readonly FormVatLine[], types: readonly LineVatTypeOrNone[], mode: TaxMode, date: string): { subtotal: number; tax: number; total: number } {
  return previewInvoiceVat(lines, pricedTypes(types, mode), date, amountsAreFor(mode));
}

/** One line's amount as stored: its net (an inclusive line's VAT backed out of its gross). */
export const formLineNet = (line: FormVatLine, type: LineVatTypeOrNone, mode: TaxMode, date: string): number =>
  formTotals([line], [type], mode, date).subtotal;

/** `type` null: the lines with no VAT type yet (priced with none, as formTotals does; the totals say a type is needed). */
export interface VatByType { type: LineVatTypeOrNone; net: number; vat: number }

/**
 * The net and VAT of each type the priced lines carry, in list order, then the lines with no type yet (the totals'
 * breakdown; the sums are formTotals'). A line with no price yet (a fresh blank line) adds no row of its own, unless no
 * line has a price.
 */
export function formVatByType(lines: readonly FormVatLine[], types: readonly LineVatTypeOrNone[], mode: TaxMode, date: string): VatByType[] {
  if (mode === 'none') return [];
  const priced = lines.some((l) => l.unitPrice);
  return [...DOCUMENT_LINE_VAT_TYPES, null].flatMap((type) => {
    const mine = lines.filter((l, i) => (types[i] ?? null) === type && (!priced || l.unitPrice));
    if (mine.length === 0) return [];
    const t = formTotals(mine, mine.map(() => type), mode, date);
    return [{ type, net: t.subtotal, vat: t.tax }];
  });
}

/** What to tell the user when the customer's VAT type conflicts with the lines' types. Their choice stands. */
export function lineVatWarning(customerVat: string | null | undefined, types: readonly LineVatTypeOrNone[]): string | undefined {
  const raw = (customerVat ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  const v = asLineVatType(raw);
  if (v === null) return `This customer's VAT type "${raw}" is not one IsaFlow knows: check the VAT type on each line.`;
  const standard = types.filter((t) => t === 'standard').length;
  if (v !== 'standard') {
    return standard === 0 ? undefined
      : `This customer is ${v === 'exempt' ? 'VAT exempt' : 'zero-rated'}, but ${standard === 1 ? 'a line is' : `${standard} lines are`} standard-rated.`;
  }
  return types.length > 0 && types.every((t) => t === 'zero_rated' || t === 'exempt') ? 'This customer is standard-rated, but no line charges VAT.' : undefined;
}

/**
 * A draft kept on this device before per-line VAT (its form carries the one `taxRate`, its lines no type) as the form
 * holds it now, priced as it was: at No VAT or 0% each line zero-rated (exempt for an exempt customer: `vatFallback`), at
 * the standard rate each standard, at any other rate none yet (the line asks). A draft kept since is returned as it is.
 */
export function fromKeptDraft<L extends FormVatLine, F extends { invoiceDate: string }>(d: { form: F & { taxRate?: unknown }; lines: L[]; taxMode: TaxMode }):
  { form: F; lines: L[]; taxMode: TaxMode } {
  const { taxRate, ...form } = d.form;
  const taxMode: TaxMode = d.taxMode === 'none' ? 'exclusive' : d.taxMode;
  if (typeof taxRate !== 'number') return { form: form as unknown as F, lines: d.lines, taxMode };
  const lines = d.lines.map((l): L => {
    if ('vatType' in l || 'vatFallback' in l) return l;
    if (d.taxMode === 'none' || taxRate === 0) return { ...l, vatFallback: 'zero_rated' };
    return { ...l, vatType: typeForRate(taxRate, form.invoiceDate) };
  });
  return { form: form as unknown as F, lines, taxMode };
}
