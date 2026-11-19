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
 * The type posted is the stored, approved line's own (the approval digest covers it, migration 1008): nothing here
 * picks one. Account, job and dimension rules are checked on the same stored lines before this runs
 * (invoiceRevenuePosting.postableInvoiceLines).
 */
import type { JournalLineInput, VatType } from '../../types/gl.types';
import { RATED_VAT_TYPES, normaliseVatType } from '../shared/vatTypes';
import { InvoiceLineCodingRefusal } from './invoiceLineCoding';
import type { StoredRevenueLine } from './invoiceRevenueLines';

/** A stored invoice line with its VAT (customer_invoice_items.vat_type / tax_amount); both null on a legacy line. */
export interface StoredVatLine extends StoredRevenueLine {
  vatType?: string | null;
  taxAmount?: number | null;
}

/** The header figures the lines must foot to: Σ amount = subtotal, Σ tax_amount = tax_amount, to the cent. */
export interface TypedInvoiceHeader {
  subtotal: number;
  taxAmount: number;
}

export type LineVatShape = 'typed' | 'legacy' | 'partial';

const isTyped = (l: Pick<StoredVatLine, 'vatType' | 'taxAmount'>): boolean => l.vatType != null && l.taxAmount != null;
const cents = (n: number): number => Math.round(n * 100);
const money = (c: number): string => (c / 100).toFixed(2);

/** typed: every line carries its VAT; legacy: none does (or there are no lines); partial: some do. */
export function lineVatShape(lines: ReadonlyArray<Pick<StoredVatLine, 'vatType' | 'taxAmount'>>): LineVatShape {
  const typed = lines.filter(isTyped).length;
  if (typed === 0) return 'legacy';
  return typed === lines.length ? 'typed' : 'partial';
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
  for (const [i, l] of lines.entries()) {
    const type = normaliseVatType(l.vatType);
    if (type === null || type !== l.vatType) return `line ${i + 1} has the unknown VAT type "${String(l.vatType)}".`;
    if (!RATED_VAT_TYPES.includes(type) && cents(l.taxAmount!) !== 0) {
      return `line ${i + 1} is ${type}, which charges no VAT, but carries ${money(cents(l.taxAmount!))} of VAT. `
        + 'Re-save the draft so its VAT is recalculated.';
    }
  }
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
  const problem = typedLinesProblem(lines, header);
  if (problem) throw new InvoiceLineCodingRefusal(`Invoice ${invoiceNumber}: ${problem}`);
  if (lineVatShape(lines) !== 'typed') {
    throw new Error(`Invoice ${invoiceNumber}: its lines are not typed; post them as a legacy invoice`);
  }
  const revenue = new Map<string, { base: Omit<JournalLineInput, 'debit' | 'credit'>; cents: number }>();
  const vat = new Map<VatType, number>();
  for (const l of lines) {
    // typedLinesProblem has read every type as a known one.
    const vatType = l.vatType as VatType;
    const glAccountId = l.glAccountId ?? input.defaultRevenueAccountId;
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
    vat.set(vatType, (vat.get(vatType) ?? 0) + cents(l.taxAmount!));
  }
  const vatLegs = [...vat].map(([vatType, c]) => creditLeg({
    glAccountId: input.vatOutputAccountId, description: `VAT Output: ${invoiceNumber}`, vatType,
  }, c));
  return [...[...revenue.values()].map((g) => creditLeg(g.base, g.cents)), ...vatLegs]
    .filter((l): l is JournalLineInput => l !== null);
}
