/**
 * The VAT on a quote's lines: per-line VAT types, the contract and the pricing of a customer invoice (per-line VAT
 * programme, migration 1024), so a quote converts to an invoice of the same figures.
 *
 *   type     invoiceLineVatTypes, worded for a quote: a line `vatType` (standard, zero_rated, exempt); else the LEGACY
 *            per-line `taxRate` (what the quote form sends: one rate on every line), read as the invoice's legacy header
 *            rate, line by line: the standard rate on the quote date -> standard, 0 -> zero_rated, anything else refused;
 *            on an edit an identical stored line whose type has that rate keeps it. A `vatType` and a `taxRate` on one
 *            quote are refused, as an invoice refuses a line type with its header rate. Else, on an edit, the IDENTICAL
 *            stored line's type (customerInvoiceDraftVat.keptTypes); else the default chain (the customer's zero-rated /
 *            exempt default, the item's vat_on_sales, standard).
 *   price    invoiceLineVatPricing.priceInvoiceVat: `amount` = NET, `tax_amount` = the line's VAT rounded on the line,
 *            `tax_rate` = its type's rate on the quote date; header = the sum of the lines, `tax_rate` = the highest
 *            line rate. `amountsAre` 'inclusive' stores the unit price as entered and backs the VAT out of the gross.
 *   no VAT   a company not registered for VAT writes UNTYPED lines (vat_type / tax_amount NULL, rate 0) and exclusive;
 *            a standard line or a rate above 0 is refused.
 *
 * Every refusal is raised before the first write: InvoiceLineVatRefusal / InvoiceVatNotRegisteredRefusal (registered for
 * MCP, a REST 400 with its code), LineValidationError for the mode and the total. What an invoice of the quote could not
 * approve (1 x R0.03 standard: the VAT rounds to nothing) is refused here (invoiceVatLegs.typedLinesProblem).
 */
import { InvoiceLineVatRefusal, type DocumentLineVatType, type ResolvedLineVat } from './invoiceLineVatTypes';
import { invoiceVatParties, resolveInvoiceVatFor } from './invoiceLineVatDefaults';
import { priceInvoiceVat, type AmountsAre, type VatPricedHeader, type VatPricedLine } from './invoiceLineVatPricing';
import { keptTypes } from './customerInvoiceDraftVat';
import { typedLinesProblem } from './invoiceVatLegs';
import { LineValidationError, quoteAmountsAre } from './quoteLineChecks';

export interface QuoteVatLineIn {
  description: string;
  quantity: number;
  unitPrice: number;
  taxRate?: unknown;
  vatType?: unknown;
  itemId?: unknown;
}

/** A stored line as getQuote maps it, for the edit's identical-line rule. */
export interface StoredQuoteVatLine { description: string; quantity: number; unitPrice: number; taxRate: number; vatType: string | null }

export interface PricedQuote { lines: VatPricedLine[]; header: VatPricedHeader }

const given = (v: unknown): boolean => v !== undefined && v !== null;

/** Each line's type (or untyped for a non-vendor): the invoice contract, the legacy per-line rate read as a header rate. */
async function resolveQuoteVat(
  companyId: string, clientId: string | null, quoteDate: string, lines: readonly QuoteVatLineIn[], stored: readonly StoredQuoteVatLine[] | undefined,
): Promise<ResolvedLineVat> {
  if (lines.some((l) => given(l.vatType)) && lines.some((l) => given(l.taxRate))) {
    throw new InvoiceLineVatRefusal('Send a vatType on each line or a taxRate, not both: the rate comes from the VAT type.');
  }
  const kept = stored ? keptTypes(lines, stored.map((s) => ({
    description: s.description, quantity: s.quantity, unit_price: s.unitPrice, vat_type: s.vatType, tax_rate: s.taxRate,
  }))) : undefined;
  const parties = await invoiceVatParties(companyId, clientId);
  // One resolution per legacy rate (and one for the lines with none): each group's rate is that group's header rate.
  const groups = new Map<number | null, number[]>();
  lines.forEach((l, i) => {
    const rate = given(l.taxRate) ? Number(l.taxRate) : null;
    groups.set(rate, [...(groups.get(rate) ?? []), i]);
  });
  const types: DocumentLineVatType[] = [];
  let typed = true;
  for (const [rate, idx] of groups) {
    const vat = await resolveInvoiceVatFor(companyId, parties, {
      invoiceDate: quoteDate, headerTaxRate: rate ?? undefined, document: 'quote', label: (j) => `items[${idx[j]}]`,
      lines: idx.map((i) => ({ vatType: lines[i]!.vatType, itemId: lines[i]!.itemId })),
      kept: kept ? idx.map((i) => kept[i] ?? null) : undefined,
    });
    if (!vat.typed) typed = false;
    else vat.types.forEach((t, j) => { types[idx[j]!] = t; });
  }
  return typed ? { typed: true, types } : { typed: false };
}

/**
 * The quote's lines and header as stored (see the header). `stored` = the quote's current lines on an edit. Throws
 * before any write; the lines' quantity and price are already W1-checked (quoteLineChecks.assertValidLines).
 */
export async function priceQuoteLines(companyId: string, args: {
  clientId: string | null; quoteDate: string; lines: readonly QuoteVatLineIn[]; amountsAre: unknown; stored?: readonly StoredQuoteVatLine[];
}): Promise<PricedQuote> {
  const amountsAre = quoteAmountsAre(args.amountsAre);
  const vat = await resolveQuoteVat(companyId, args.clientId, args.quoteDate, args.lines, args.stored);
  const priced = priceInvoiceVat(args.lines.map((l) => ({ quantity: Number(l.quantity), unitPrice: Number(l.unitPrice) })), vat, args.quoteDate, amountsAre);
  // numeric(15,2): priceInvoiceVat leaves a line past the column unpriced and carries it into the total.
  if (!(Math.abs(priced.header.total) < 1e13)) throw new LineValidationError('The quote total is too large');
  const problem = typedLinesProblem(
    priced.lines.map((l) => ({ amount: l.amount, taxAmount: l.taxAmount, vatType: l.vatType, glAccountId: null, projectId: null })),
    { subtotal: priced.header.subtotal, taxAmount: priced.header.tax, totalAmount: priced.header.total, invoiceDate: args.quoteDate, amountsAre },
  );
  if (problem) throw new InvoiceLineVatRefusal(`This quote could not be invoiced as priced: ${problem}`);
  return priced;
}
