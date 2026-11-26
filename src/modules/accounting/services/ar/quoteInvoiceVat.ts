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
 * When the invoice's figures are not the quote's (the rate moved, or the stored figures do not foot), the conversion says so: `warnings` (QUOTE_TOTAL_CHANGED,
 * both totals and both standard rates), which the convert response carries to the caller.
 *
 * assertOrderableVat: what a sales order (no amounts_are, no line VAT type yet) cannot carry, refused before its claim;
 * orderUnitPrice: the ex-VAT price an inclusive quote's order line is written with.
 */
import { isRatedDate, SA_STANDARD_VAT_RATE_PCT, standardVatRatePctOn } from '@/lib/vat/standardRate';
import { log } from '@/lib/logger';
import { assertPricedPostable, resolveInvoiceVat } from './invoiceLineVatDefaults';
import { priceInvoiceVat, type AmountsAre } from './invoiceLineVatPricing';
import { InvoiceLineVatRefusal, InvoiceVatNotRegisteredRefusal } from './invoiceLineVatTypes';
import { lineVatShape } from './invoiceVatLegs';
import type { Quote } from './quoteService';
import { LineValidationError } from './quoteLineChecks';

/** Something the caller should see about a conversion that still went through. */
export interface QuoteConvertWarning {
  code: 'QUOTE_TOTAL_CHANGED';
  message: string;
  quoteTotal: number;
  invoiceTotal: number;
  /** The standard rate on the quote's date and on the invoice's (null where no rate can be read). */
  quoteRatePct: number | null;
  invoiceRatePct: number | null;
}

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
  warnings: QuoteConvertWarning[];
}

/**
 * Refuses (LineValidationError, a 400) a quote a sales order cannot carry as priced: a typed one with an EXEMPT line (an
 * order line has a rate only, so exempt would come back zero-rated: another VAT201 field). Until sales orders carry
 * per-line VAT types. An INCLUSIVE quote is carried: the order takes each line's unit price EX VAT (orderUnitPrice) and
 * the quote's own net, VAT and total, so its figures are the quote's.
 */
export function assertOrderableVat(quote: Quote): void {
  const exempt = (quote.lines ?? []).findIndex((l) => l.vatType === 'exempt');
  if (exempt >= 0) {
    throw new LineValidationError(`Quote ${quote.quoteNumber}: line ${exempt + 1} is exempt from VAT, and a sales order cannot `
      + 'carry a VAT type yet (it would be invoiced as zero-rated): convert the quote to an invoice instead.');
  }
}

/**
 * The unit price a sales order line is written with. An order holds prices BEFORE VAT (its invoice copies them, and the
 * invoice's VAT is added on top), so an inclusive quote's gross price (stored as entered) would be taxed twice: its line's
 * stored NET over its quantity is used instead, to the cent. The order's line total and header are the quote's stored
 * figures, so the totals are the quote's whatever a unit price rounds to (1 000 x R0.03 incl: R0.03 a unit, R26.09 net).
 */
export function orderUnitPrice(quote: Quote, line: { quantity: number; unitPrice: number; lineTotal: number }): number {
  if (quote.amountsAre !== 'inclusive' || line.quantity === 0) return line.unitPrice;
  const cents = Math.abs(line.lineTotal / line.quantity) * 100;
  const rounded = Math.round(cents + 1e-9) / 100;
  return line.lineTotal / line.quantity < 0 ? -rounded : rounded;
}

const rateOn = (d: string): number | null => (isRatedDate(d) ? standardVatRatePctOn(d) : null);

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
      warnings: [],
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
  const warnings: QuoteConvertWarning[] = [];
  if (subtotal !== quote.subtotal || tax !== quote.taxAmount || total !== quote.total) {
    const quoteRatePct = rateOn(quote.quoteDate);
    const invoiceRatePct = rateOn(invoiceDate);
    log.warn('Quote invoiced at the VAT on the invoice date, not the quote\'s', {
      quoteId: quote.id, quoteDate: quote.quoteDate, invoiceDate, quoted: quote.total, invoiced: total,
    }, 'quoteInvoiceVat');
    warnings.push({
      code: 'QUOTE_TOTAL_CHANGED', quoteTotal: quote.total, invoiceTotal: total, quoteRatePct, invoiceRatePct,
      // Said by what moved: the standard rate between the two dates, else the figures themselves (the rate is the same).
      message: quoteRatePct !== invoiceRatePct
        ? `The invoice totals ${total.toFixed(2)}, not the quote's ${quote.total.toFixed(2)}: VAT is charged at the rate on the `
          + `invoice date ${invoiceDate} (${invoiceRatePct ?? '?'}%), not the quote's ${quote.quoteDate} (${quoteRatePct ?? '?'}%). Check the draft before sending it.`
        : `The invoice totals ${total.toFixed(2)}, not the quote's ${quote.total.toFixed(2)}: its lines priced to other figures than the `
          + `quote stored (subtotal ${subtotal.toFixed(2)} and VAT ${tax.toFixed(2)}, quoted ${quote.subtotal.toFixed(2)} and ${quote.taxAmount.toFixed(2)}), `
          + 'at the same VAT rate. Check the draft before sending it.',
    });
  }
  return {
    subtotal, tax, total, taxRate, amountsAre: priced.header.amountsAre, warnings,
    lines: priced.lines.map((l) => ({ qty: l.qty, price: l.price, amount: l.amount, taxRate: l.taxRate, taxAmount: l.taxAmount, vatType: l.vatType })),
  };
}
