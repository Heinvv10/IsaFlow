/**
 * The credit half of a customer invoice journal whose lines carry their own VAT type (migration 1008). Pure, so every
 * rule is provable against the real journal validator (tests/unit/services/ar/invoiceVatLegs.test.ts).
 *
 * A line is TYPED when `vat_type` and `tax_amount` are both stored; an invoice is typed when every line is. A LEGACY
 * invoice (no typed line) is not this file's: postCustomerInvoiceToGL posts it exactly as before (the revenue legs of
 * invoiceRevenueLines, one 'standard' VAT Output leg of the header tax). A PARTLY typed invoice is refused.
 *
 * TYPED. Revenue: one leg per (account ?? default_revenue, job, CC1, CC2, BU, VAT type), each the sum of its lines'
 * net, coded with that type; a group netting negative is a debit on its own leg, a zero one is dropped. VAT Output: one
 * leg per type for the sum of its lines' `tax_amount`, coded with that type; a zero leg is dropped. The receivable
 * (the header total) is the caller's. The lines' own net and VAT are what post, never a re-split of the header: the
 * VAT was rounded on the line (shared/vatLineAmounts), so the lines must foot to the header exactly, to the cent, or
 * the invoice is refused before anything is written. A line's `amount` is its NET on every invoice, typed or legacy,
 * VAT-inclusive or not (gross = amount + tax_amount): `amounts_are` says how `unit_price` was entered, never what
 * `amount` means, so nothing here reads it.
 *
 * WHAT MAY POST (PR #1648 review). Only the types a document line is offered (DOCUMENT_LINE_VAT_TYPES: standard,
 * zero_rated, exempt): a sales line typed reverse_charge, bad_debt or imported would post a coded leg the VAT201 puts in
 * field 1 at full base or in no field at all. The writer PR widens POSTABLE_LINE_VAT_TYPES type by type, each with a
 * proof of how the readers place it. A rated line's VAT is its own: exactly its net at its type's rate on the invoice
 * date (vatLineAmounts), or within one cent of it on a VAT-inclusive invoice, whose VAT was backed out of a gross. A rated type whose lines carry net
 * but whose VAT rounds to nothing, or VAT on no net, is refused: a coded base with no VAT leg reaches no field. The
 * header total must be subtotal + VAT: the receivable is debited for it.
 *
 * The type posted is the stored, approved line's own (the approval digest covers it, migration 1008): nothing here
 * picks one. Account, job and dimension rules are checked on the same stored lines before this runs
 * (invoiceRevenuePosting.postableInvoiceLines).
 */
import type { JournalLineInput, VatType } from '../../types/gl.types';
import { VatRateDateError } from '@/lib/vat/standardRate';
import { DOCUMENT_LINE_VAT_TYPES, RATED_VAT_TYPES, VAT_TYPES, vatRatePctOn } from '../shared/vatTypes';
import { vatLineAmounts } from '../shared/vatLineAmounts';
import { InvoiceLineCodingRefusal } from './invoiceLineCoding';
import type { StoredRevenueLine } from './invoiceRevenueLines';

/** A stored invoice line with its VAT (customer_invoice_items.vat_type / tax_amount); both null on a legacy line. */
export interface StoredVatLine extends StoredRevenueLine {
  vatType?: string | null;
  taxAmount?: number | null;
}

/** The header the lines must foot to: Σ amount = subtotal, Σ tax_amount = tax_amount, total = both, to the cent. */
export interface TypedInvoiceHeader {
  subtotal: number;
  taxAmount: number;
  totalAmount: number;
  /** The invoice date (a pg Date or 'YYYY-MM-DD'): the rate a rated line's VAT is checked at. */
  invoiceDate: string | Date;
  /**
   * customer_invoices.amounts_are, read for ONE purpose: on an 'inclusive' invoice a rated line's VAT was backed out of
   * a gross and may differ by a cent from its net at the rate; otherwise it must be exact. `amount` is net either way.
   */
  amountsAre: string | null;
}

/** The types a customer invoice line may POST with in this PR (see the header). */
export const POSTABLE_LINE_VAT_TYPES: readonly VatType[] = DOCUMENT_LINE_VAT_TYPES;

/**
 * A stored line's (or journal leg's) VAT type: the ledger's canonical spelling only, never a legacy one ('zero',
 * 'none'), which no writer of these columns stores. The ONE reader the poster, the PDF and the credit-note legs use.
 */
export function storedVatType(value: unknown): VatType | null {
  return typeof value === 'string' && (VAT_TYPES as readonly string[]).includes(value) ? value as VatType : null;
}

export type LineVatShape = 'typed' | 'legacy' | 'partial';

const isTyped = (l: Pick<StoredVatLine, 'vatType' | 'taxAmount'>): boolean => l.vatType != null && l.taxAmount != null;
const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): string => (c / 100).toFixed(2);
const RESAVE = 'Re-save the draft so its VAT is recalculated.';

/** typed: every line carries its VAT; legacy: none does (or there are no lines); partial: some do. */
export function lineVatShape(lines: ReadonlyArray<Pick<StoredVatLine, 'vatType' | 'taxAmount'>>): LineVatShape {
  const typed = lines.filter(isTyped).length;
  if (typed === 0) return 'legacy';
  return typed === lines.length ? 'typed' : 'partial';
}

/** Why line i's type or VAT cannot post, or null. */
function lineProblem(l: StoredVatLine, i: number, invoiceDate: string | Date, inclusive: boolean): string | null {
  const type = storedVatType(l.vatType);
  if (type === null) return `line ${i + 1} has the unknown VAT type "${String(l.vatType)}".`;
  if (!POSTABLE_LINE_VAT_TYPES.includes(type)) {
    return `line ${i + 1} is typed ${type}, which a customer invoice line cannot post yet `
      + '(standard, zero_rated or exempt). Re-save the draft with one of those.';
  }
  const carries = cents(l.taxAmount!);
  if (!RATED_VAT_TYPES.includes(type)) {
    return carries === 0 ? null : `line ${i + 1} is ${type}, which charges no VAT, but carries ${money(carries)} of VAT. ${RESAVE}`;
  }
  const own = cents(vatLineAmounts(l.amount, type, invoiceDate).vat);
  if (Math.abs(carries - own) <= (inclusive ? 1 : 0)) return null;
  return `line ${i + 1} is ${type}: its VAT on ${money(cents(l.amount))} at ${vatRatePctOn(type, invoiceDate)}% is `
    + `${money(own)}, but it carries ${money(carries)}. ${RESAVE}`;
}

/** Per rated type: net with VAT rounding to nothing, or VAT on no net. Either reaches no VAT201 field. */
function ratedTypeProblem(lines: readonly StoredVatLine[]): string | null {
  for (const type of RATED_VAT_TYPES) {
    const of = lines.filter((l) => l.vatType === type);
    const net = of.reduce((s, l) => s + cents(l.amount), 0);
    const vat = of.reduce((s, l) => s + cents(l.taxAmount!), 0);
    if (net !== 0 && vat === 0) {
      return `its ${type} lines come to ${money(net)} but the VAT on them rounds to nothing, so they would reach no `
        + 'VAT201 field. Raise them as one line large enough to carry VAT, or remove them.';
    }
    if (net === 0 && vat !== 0) return `its ${type} lines carry ${money(vat)} of VAT on no net. ${RESAVE}`;
  }
  return null;
}

/**
 * Why a typed invoice's lines cannot post behind its header, or null (a legacy invoice: always null). The ONE wording
 * approve's pre-write check and the builder refuse with.
 */
export function typedLinesProblem(lines: readonly StoredVatLine[], header: TypedInvoiceHeader): string | null {
  const shape = lineVatShape(lines);
  if (shape === 'legacy') return null;
  if (shape === 'partial') {
    return 'some of its lines carry a VAT type and some do not. Re-save the draft so every line is priced by its VAT type.';
  }
  try {
    for (const [i, l] of lines.entries()) {
      const problem = lineProblem(l, i, header.invoiceDate, header.amountsAre === 'inclusive');
      if (problem) return problem;
    }
  } catch (err) {
    if (err instanceof VatRateDateError) return `its date cannot be read for a VAT rate (${err.message}).`;
    throw err;
  }
  const rated = ratedTypeProblem(lines);
  if (rated) return rated;
  const net = lines.reduce((s, l) => s + cents(l.amount), 0);
  if (net !== cents(header.subtotal)) {
    return `its lines' net adds up to ${money(net)} but its subtotal is ${money(cents(header.subtotal))}. `
      + 'Re-save the draft so its totals are recalculated.';
  }
  const vat = lines.reduce((s, l) => s + cents(l.taxAmount!), 0);
  if (vat !== cents(header.taxAmount)) {
    return `its lines' VAT adds up to ${money(vat)} but its VAT total is ${money(cents(header.taxAmount))}. `
      + 'Re-save the draft so its totals are recalculated.';
  }
  if (cents(header.totalAmount) !== net + vat) {
    return `its total is ${money(cents(header.totalAmount))} but its subtotal plus VAT is ${money(net + vat)}. `
      + 'Re-save the draft so its totals are recalculated.';
  }
  return null;
}

/** A signed amount (cents) as a credit-side journal line: a negative one is a debit, zero is dropped. */
function creditLeg(base: Omit<JournalLineInput, 'debit' | 'credit'>, signed: number): JournalLineInput | null {
  if (signed === 0) return null;
  const amount = Math.abs(signed) / 100;
  return { ...base, debit: signed < 0 ? amount : 0, credit: signed > 0 ? amount : 0 };
}

/** The revenue and VAT Output legs of a TYPED invoice (see the header). Throws InvoiceLineCodingRefusal. */
export function typedInvoiceCreditLegs(input: {
  invoiceNumber: string;
  header: TypedInvoiceHeader;
  lines: readonly StoredVatLine[];
  defaultRevenueAccountId: string;
  vatOutputAccountId: string;
}): JournalLineInput[] {
  const { invoiceNumber, header, lines } = input;
  // A legacy invoice passes typedLinesProblem (null) but is not this builder's: the caller posts it the legacy way.
  if (lineVatShape(lines) === 'legacy') {
    throw new Error(`Invoice ${invoiceNumber}: its lines are not typed; post them as a legacy invoice`);
  }
  const problem = typedLinesProblem(lines, header);
  if (problem) throw new InvoiceLineCodingRefusal(`Invoice ${invoiceNumber}: ${problem}`);
  return typedLegs(lines, invoiceNumber, input.defaultRevenueAccountId, input.vatOutputAccountId);
}

/**
 * The leg-building step alone, below the refusal: lines already held to typedLinesProblem. Each revenue group and each
 * VAT leg carries the type of the lines that produced it.
 */
export function typedLegs(
  lines: readonly StoredVatLine[], invoiceNumber: string, defaultRevenueAccountId: string, vatOutputAccountId: string,
): JournalLineInput[] {
  const revenue = new Map<string, { base: Omit<JournalLineInput, 'debit' | 'credit'>; cents: number }>();
  const vat = new Map<VatType, number>();
  for (const l of lines) {
    const vatType = storedVatType(l.vatType);
    if (vatType === null) throw new Error(`Invoice ${invoiceNumber}: a line's VAT type is not one the ledger knows`);
    const glAccountId = l.glAccountId ?? defaultRevenueAccountId;
    const key = [glAccountId, l.projectId, l.cc1Id, l.cc2Id, l.buId, vatType].map((v) => v ?? '').join('|');
    const group = revenue.get(key) ?? {
      base: {
        glAccountId, description: `Revenue: ${invoiceNumber}`, projectId: l.projectId ?? undefined,
        cc1Id: l.cc1Id ?? undefined, cc2Id: l.cc2Id ?? undefined, buId: l.buId ?? undefined, vatType,
      },
      cents: 0,
    };
    group.cents += cents(l.amount);
    revenue.set(key, group);
    vat.set(vatType, (vat.get(vatType) ?? 0) + cents(l.taxAmount ?? 0));
  }
  const vatLegs = [...vat].map(([vatType, c]) => creditLeg({
    glAccountId: vatOutputAccountId, description: `VAT Output: ${invoiceNumber}`, vatType,
  }, c));
  return [...[...revenue.values()].map((g) => creditLeg(g.base, g.cents)), ...vatLegs]
    .filter((l): l is JournalLineInput => l !== null);
}
