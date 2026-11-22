/**
 * What a quote's invoice carries (quoteConvertService.convertToInvoice), decided before the conversion claims the quote.
 *
 *   TYPED quote (every line has vat_type and tax_amount, migration 1024): each line keeps its VAT type, its unit price as
 *     stored and the quote's `amounts_are`, and is priced at the INVOICE date by the invoice's own pricing
 *     (invoiceLineVatPricing), held to the poster's check (assertPricedPostable). On the same rate that is the quote's
 *     stored figures exactly (the quote was priced by the same function); across a change of the statutory rate the
 *     invoice charges the rate on its own date (an exclusive line keeps its net, an inclusive one its gross), logged.
 *     A company no longer registered for VAT cannot invoice a standard line (INVOICE_VAT_NOT_REGISTERED); its
 *     zero-rated / exempt lines convert untyped, as its invoices are written.
 *   LEGACY quote (no line typed: written before 1024, or for a company not registered for VAT): the stored figures are
 *     copied as before (each line's own rate and amount, the header totals), never re-priced; the invoice is untyped.
 *   A quote with some lines typed and some not is refused: neither shape can carry it.
 */
import { SA_STANDARD_VAT_RATE_PCT } from '@/lib/vat/standardRate';
import { log } from '@/lib/logger';
import { assertPricedPostable, resolveInvoiceVat } from './invoiceLineVatDefaults';
import { priceInvoiceVat, type AmountsAre } from './invoiceLineVatPricing';
import { InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal } from './invoiceLineVatTypes';
import { lineVatShape } from './invoiceVatLegs';
import type { Quote } from './quoteService';

export interface QuoteInvoiceLine { qty: number; price: number; amount: number; taxRate: number; taxAmount: number | null; vatType: string | null }

export interface QuoteInvoiceVat {
  subtotal: number;
  tax: number;
  total: number;
  taxRate: number;
  /** null on a legacy invoice (reads exclusive), as before migration 1024. */
  amountsAre: AmountsAre | null;
  /** In the quote's line order. */
  lines: QuoteInvoiceLine[];
}

export async function quoteInvoiceVat(companyId: string, quote: Quote, invoiceDate: string): Promise<QuoteInvoiceVat> {
  const lines = quote.lines ?? [];
  const shape = lineVatShape(lines.map((l) => ({ vatType: l.vatType, taxAmount: l.taxAmount })));
  if (shape === 'partial') {
    throw new InvoiceLineVatRefusal(`Quote ${quote.quoteNumber}: some of its lines carry a VAT type and some do not. `
      + 'Save the quote again so every line is priced by its VAT type, then convert it.');
  }
  if (shape === 'legacy') {
    // The invoice's one rate, when every line shares it: the draft edit re-taxes at the header rate, so a 0% quote must
    // not come back at the column default of 15%. A mixed-rate quote gets 15% as before (its lines keep their own rates).
    const rates = new Set(lines.map((l) => Number(l.taxRate)));
    return {
      subtotal: quote.subtotal, tax: quote.taxAmount, total: quote.total,
      taxRate: rates.size === 1 ? [...rates][0]! : SA_STANDARD_VAT_RATE_PCT, amountsAre: null,
      lines: lines.map((l) => ({ qty: l.quantity, price: l.unitPrice, amount: l.lineTotal, taxRate: l.taxRate, taxAmount: null, vatType: null })),
    };
  }
  const amountsAre: AmountsAre = quote.amountsAre === 'inclusive' ? 'inclusive' : 'exclusive';
  const vat = await resolveInvoiceVat(companyId, quote.clientId, {
    invoiceDate, headerTaxRate: undefined, lines: lines.map((l) => ({ vatType: l.vatType })), label: (i) => `quote line ${i + 1}`,
  }).catch((err: unknown) => {
    if (!(err instanceof InvoiceVatNotRegisteredRefusal)) throw err;
    throw new InvoiceVatNotRegisteredRefusal(`Quote ${quote.quoteNumber} charges VAT, but this company is no longer registered for VAT, so its `
      + 'invoices carry none: the quote cannot be invoiced as priced. Quote the customer again without VAT.');
  });
  const priced = priceInvoiceVat(lines.map((l) => ({ quantity: l.quantity, unitPrice: l.unitPrice })), vat, invoiceDate, amountsAre);
  assertPricedPostable(priced, invoiceDate);
  const { subtotal, tax, total, taxRate } = priced.header;
  if (subtotal !== quote.subtotal || tax !== quote.taxAmount || total !== quote.total) {
    log.warn('Quote invoiced at the VAT on the invoice date, not the quote\'s', {
      quoteId: quote.id, quoteDate: quote.quoteDate, invoiceDate, quoted: quote.total, invoiced: total,
    }, 'quoteInvoiceVat');
  }
  return {
    subtotal, tax, total, taxRate, amountsAre: priced.header.amountsAre,
    lines: priced.lines.map((l) => ({ qty: l.qty, price: l.price, amount: l.amount, taxRate: l.taxRate, taxAmount: l.taxAmount, vatType: l.vatType })),
  };
}
