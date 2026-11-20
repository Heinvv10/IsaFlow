/**
 * The VAT type of each line of a customer invoice being WRITTEN (create, draft edit, the unsaved preview): the request
 * contract of per-line VAT (Hein's rulings, 2026-11-19/20). The rate is never the caller's: it comes from the line's type
 * and the invoice date (shared/vatTypes). Pure; the reads behind `defaults` are invoiceLineVatDefaults'.
 *
 *   both a line `vatType` and the header `taxRate`         refused (no caller sends both)
 *   line `vatType`                                         normaliseVatType, one of DOCUMENT_LINE_VAT_TYPES, else refused
 *   else header `taxRate` (legacy input), S = the standard rate on the invoice date:
 *        S -> standard; 0 -> zero_rated (how a zero-VAT invoice has always been reported); anything else refused.
 *        On a draft edit a line whose identical stored line carries a type OF THAT RATE keeps it (an exempt line saved
 *        again at 0 stays exempt).
 *   else the identical stored line's type (draft edit only; storedLineVatType)
 *   else the default chain (defaultLineVatType): the customer's default_vat_type when zero-rated or exempt; else the
 *        item's vat_on_sales; else the line's revenue account's default_vat_code when it is a document line type
 *        ('none' / NULL are the chart default: no opinion); else standard.
 *   a per-line `taxRate` (the edit schema's legacy field) must be the resolved type's rate on the date, else refused.
 *
 * A company NOT registered for VAT: every line is written UNTYPED (vat_type / tax_amount NULL, rate 0, no VAT), the
 * legacy shape of a zero-VAT invoice: such a company files no VAT201 (the VAT routes are withVatVendor-gated) and the
 * legacy poster posts no VAT leg for it. A request for VAT (a standard line, a header or line taxRate above 0) is
 * refused; zero_rated / exempt lines are accepted and written untyped (no VAT either way).
 */
import { standardVatRatePctOn, VatRateDateError } from '@/lib/vat/standardRate';
import { DOCUMENT_LINE_VAT_TYPES, normaliseVatType, vatRatePctOn } from '../shared/vatTypes';
import type { VatType } from '../../types/gl.types';

export type DocumentLineVatType = (typeof DOCUMENT_LINE_VAT_TYPES)[number];

/** A line's VAT type, rate or the pair of inputs refused; before any write. Registered for MCP (vatLineRefusalCodes). */
export class InvoiceLineVatRefusal extends Error {
  readonly code = 'INVOICE_LINE_VAT_REFUSED';
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceLineVatRefusal';
  }
}

/** VAT asked of a company that is not registered for it; before any write. Registered for MCP (vatLineRefusalCodes). */
export class InvoiceVatNotRegisteredRefusal extends Error {
  readonly code = 'INVOICE_VAT_NOT_REGISTERED';
  constructor(message: string) {
    super(message);
    this.name = 'InvoiceVatNotRegisteredRefusal';
  }
}

/** What the customer, the line's item and its revenue account say about its VAT (raw column values). */
export interface LineVatOpinions { customer: unknown; item: unknown; account: unknown }

export interface LineVatRequest { vatType?: unknown; taxRate?: unknown }

export interface ResolveLineVatInput {
  registered: boolean;
  invoiceDate: string | Date;
  /** The legacy header rate; undefined / null = not given. */
  headerTaxRate: unknown;
  lines: readonly LineVatRequest[];
  /** Per line, what the default chain reads (only consulted for a line nothing else types). */
  defaults: readonly LineVatOpinions[];
  /** Draft edit only: per line, the type of the identical stored line (storedLineVatType), or null. */
  kept?: readonly (DocumentLineVatType | null)[];
  label?: (i: number) => string;
}

export type ResolvedLineVat = { typed: true; types: DocumentLineVatType[] } | { typed: false };

const given = (v: unknown): boolean => v !== undefined && v !== null;
const isDocumentType = (t: VatType | null): t is DocumentLineVatType =>
  t !== null && (DOCUMENT_LINE_VAT_TYPES as readonly string[]).includes(t);
/** A column's text as a type: trimmed and lower-cased (default_vat_type is free text), legacy spellings read. */
const opinion = (v: unknown): VatType | null => normaliseVatType(typeof v === 'string' ? v.trim().toLowerCase() : v);

/** The default chain (see the header). */
export function defaultLineVatType(o: LineVatOpinions): DocumentLineVatType {
  const customer = opinion(o.customer);
  if (customer === 'zero_rated' || customer === 'exempt') return customer;
  const item = opinion(o.item);
  if (isDocumentType(item)) return item;
  const account = opinion(o.account);
  if (isDocumentType(account)) return account;
  return 'standard';
}

/**
 * A stored line's type as a draft edit keeps it: its own when it is a document line type; a legacy (NULL) line reads as
 * standard when its rate is above zero, else zero_rated; any other stored type is not kept (null).
 */
export function storedLineVatType(vatType: unknown, taxRate: unknown): DocumentLineVatType | null {
  if (vatType == null) return Number(taxRate ?? 0) > 0 ? 'standard' : 'zero_rated';
  const t = normaliseVatType(vatType);
  return isDocumentType(t) ? t : null;
}

function finiteRate(v: unknown, name: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new InvoiceLineVatRefusal(`${name} must be a number`);
  return v;
}

function lineType(v: unknown, label: string): DocumentLineVatType {
  const t = normaliseVatType(v);
  if (t === null) {
    throw new InvoiceLineVatRefusal(`${label}: ${JSON.stringify(v)} is not a VAT type; a line is standard, zero_rated or exempt`);
  }
  if (!isDocumentType(t)) {
    throw new InvoiceLineVatRefusal(`${label} cannot be ${t}: a customer invoice line is standard, zero_rated or exempt`);
  }
  return t;
}

const day = (d: string | Date): string => (typeof d === 'string' ? d.slice(0, 10)
  : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);

function standardRate(date: string | Date): number {
  try {
    return standardVatRatePctOn(date);
  } catch (err) {
    if (err instanceof VatRateDateError) throw new InvoiceLineVatRefusal(`The invoice date has no VAT rate: ${err.message}`);
    throw err;
  }
}

/** Each line's VAT type, or `typed: false` for a non-vendor. Throws InvoiceLineVatRefusal / InvoiceVatNotRegisteredRefusal. */
export function resolveInvoiceLineVat(input: ResolveLineVatInput): ResolvedLineVat {
  const label = input.label ?? ((i: number) => `items[${i}]`);
  const headerGiven = given(input.headerTaxRate);
  if (headerGiven && input.lines.some((l) => given(l.vatType))) {
    throw new InvoiceLineVatRefusal('Send a vatType on each line or the invoice\'s taxRate, not both: the rate comes from the VAT type.');
  }
  const header = headerGiven ? finiteRate(input.headerTaxRate, 'taxRate') : null;
  const named = input.lines.map((l, i) => (given(l.vatType) ? lineType(l.vatType, label(i)) : null));
  const lineRates = input.lines.map((l, i) => (given(l.taxRate) ? finiteRate(l.taxRate, `${label(i)}.taxRate`) : null));

  if (!input.registered) {
    const NOT_REGISTERED = 'this company is not registered for VAT, so its invoices carry no VAT';
    if (header !== null && header !== 0) {
      throw new InvoiceVatNotRegisteredRefusal('This company is not registered for VAT, so its invoices carry no VAT: leave taxRate out (or send 0).');
    }
    const standard = named.findIndex((t) => t === 'standard');
    if (standard >= 0) throw new InvoiceVatNotRegisteredRefusal(`${label(standard)} is standard-rated, but ${NOT_REGISTERED}: leave vatType out.`);
    const rated = lineRates.findIndex((r) => r !== null && r !== 0);
    if (rated >= 0) throw new InvoiceVatNotRegisteredRefusal(`${label(rated)} has taxRate ${lineRates[rated]}, but ${NOT_REGISTERED}: leave taxRate out.`);
    return { typed: false };
  }

  const s = standardRate(input.invoiceDate);
  let fromHeader: DocumentLineVatType | null = null;
  if (header !== null) {
    if (header === s) fromHeader = 'standard';
    else if (header === 0) fromHeader = 'zero_rated';
    else {
      throw new InvoiceLineVatRefusal(`taxRate ${header} is neither the VAT rate on ${day(input.invoiceDate)} (${s}%) nor 0: the rate comes `
        + 'from each line\'s VAT type (vatType: standard, zero_rated or exempt). Leave taxRate out and give each line its vatType.');
    }
  }
  const types = input.lines.map((_, i): DocumentLineVatType => {
    const kept = input.kept?.[i] ?? null;
    if (named[i]) return named[i]!;
    if (fromHeader) return kept && vatRatePctOn(kept, input.invoiceDate) === header ? kept : fromHeader;
    return kept ?? defaultLineVatType(input.defaults[i] ?? { customer: null, item: null, account: null });
  });
  types.forEach((t, i) => {
    const r = lineRates[i];
    const own = vatRatePctOn(t, input.invoiceDate);
    if (r !== null && r !== own) {
      throw new InvoiceLineVatRefusal(`${label(i)}: taxRate ${r} is not the rate of its VAT type ${t} (${own}% on `
        + `${day(input.invoiceDate)}). Leave taxRate out: the rate comes from the type.`);
    }
  });
  return { typed: true, types };
}
