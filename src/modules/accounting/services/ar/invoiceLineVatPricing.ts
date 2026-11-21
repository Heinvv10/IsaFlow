/**
 * The ONE per-line VAT pricing of a customer invoice, shared by create (customerInvoiceCreateService), the draft edit
 * (customerInvoiceDraftVat), the unsaved preview (invoicePreviewModel) and the new / edit pages' totals, so the figure
 * shown is the figure stored and posted.
 *
 *   line gross-or-net  = invoiceLineAmount(qty, unit price, discount)  (qty and price as their numeric(…, 2) columns store them)
 *   exclusive          net = that; VAT = vatLineAmounts(net, type, date).vat
 *   inclusive          that is the GROSS (unit_price stored AS ENTERED, VAT-inclusive); VAT backed out of it on the line
 *   stored             amount = NET, tax_amount = VAT, vat_type, tax_rate = the type's rate on the invoice date
 *   header             subtotal / tax / total = vatDocumentTotals over the lines; tax_rate = the highest line rate
 *
 * VAT is rounded on the line and the header is the sum of its lines (shared/vatLineAmounts): a multi-line standard
 * invoice can total a few cents differently from VAT on the subtotal (seven lines of 14.29: VAT 14.98, was 15.00).
 * UNTYPED (a company not registered for VAT, invoiceLineVatTypes): the legacy shape, no VAT, every rate 0, and
 * amounts_are 'exclusive' whatever was asked (the price as entered is the net: there is no VAT to include).
 *
 * A line amount past NUMERIC(15,2) gets no VAT and carries the total past the column (each caller's own total check
 * refuses it); the form's preview prices such a line as 0.
 *
 * Pure: safe in a client bundle.
 */
import { isRatedDate } from '@/lib/vat/standardRate';
import { vatDocumentTotals, vatLineAmounts, type AmountsAre } from '../shared/vatLineAmounts';
import { invoiceLineAmount, invoiceTotals, previewLineAmount, toColumnCents } from './invoiceLineAmount';
import { MAX_MONEY } from '@/lib/money/wholeCents';
import type { DocumentLineVatType, ResolvedLineVat } from './invoiceLineVatTypes';

export type { AmountsAre };

export interface VatPricedLine {
  qty: number;
  /** unit_price as stored: as entered (VAT-inclusive on an inclusive invoice). */
  price: number;
  /** customer_invoice_items.amount: the line's NET. */
  amount: number;
  /** null on an untyped line. */
  taxAmount: number | null;
  vatType: DocumentLineVatType | null;
  taxRate: number;
}

export interface VatPricedHeader { subtotal: number; tax: number; total: number; taxRate: number; amountsAre: AmountsAre }

interface LineIn { quantity: number; unitPrice: number; discount?: number }

/** The lines and header as stored (see the header). Throws NotADecimalError / VatRateDateError on input create refuses first. */
export function priceInvoiceVat(
  lines: readonly LineIn[], vat: ResolvedLineVat, invoiceDate: string | Date, amountsAre: AmountsAre,
): { lines: VatPricedLine[]; header: VatPricedHeader } {
  // NUMERIC(15,2) (round 11): a line whose quantity x unit price is non-finite or past the column gets no VAT (it would be
  // a rounded float of a figure nothing can store); its amount carries the header total past the column, which every
  // caller's own total check refuses in its own words (create / the preview: assertDraftTotalFits; the draft edit:
  // bad_amount). Never thrown here.
  const out = lines.map((l, i): VatPricedLine => {
    const qty = toColumnCents(l.quantity);
    const price = toColumnCents(l.unitPrice);
    const base = invoiceLineAmount(qty, price, l.discount ?? 0);
    if (!Number.isFinite(base) || Math.abs(base) > MAX_MONEY) {
      return { qty, price, amount: base, taxAmount: vat.typed ? 0 : null, vatType: vat.typed ? vat.types[i]! : null, taxRate: 0 };
    }
    if (!vat.typed) return { qty, price, amount: base, taxAmount: null, vatType: null, taxRate: 0 };
    const type = vat.types[i]!;
    const v = vatLineAmounts(base, type, invoiceDate, amountsAre);
    return { qty, price, amount: v.net, taxAmount: v.vat, vatType: type, taxRate: v.ratePct };
  });
  const totals = vat.typed
    ? vatDocumentTotals(out.map((l) => ({ net: l.amount, vat: l.taxAmount ?? 0 })))
    : (() => { const t = invoiceTotals(out.map((l) => l.amount), 0); return { subtotal: t.subtotal, vat: 0, total: t.total }; })();
  return {
    lines: out,
    header: {
      subtotal: totals.subtotal, tax: totals.vat, total: totals.total,
      // An untyped invoice (a company not registered for VAT) has no VAT to include: it is stored exclusive.
      taxRate: out.reduce((m, l) => Math.max(m, l.taxRate), 0), amountsAre: vat.typed ? amountsAre : 'exclusive',
    },
  };
}

const finite = (...ns: number[]): boolean => ns.every((n) => Number.isFinite(n) && Math.abs(n) < 1e15);

/**
 * For a form's totals: as priceInvoiceVat, but a field mid-edit prices as 0 and a date no rate is known for (empty,
 * mid-edit) or `types` null (untyped) shows no VAT, rather than throwing.
 */
export function previewInvoiceVat(
  lines: readonly LineIn[], types: readonly DocumentLineVatType[] | null, invoiceDate: string, amountsAre: AmountsAre,
): { subtotal: number; tax: number; total: number } {
  const inRange = (l: LineIn) => { const a = previewLineAmount(l.quantity, l.unitPrice, l.discount ?? 0); return a >= 0 && a <= MAX_MONEY; };
  const safe = lines.map((l) => (finite(l.quantity, l.unitPrice, l.discount ?? 0) && inRange(l) ? l : { quantity: 0, unitPrice: 0, discount: 0 }));
  const vat: ResolvedLineVat = types && isRatedDate(invoiceDate) ? { typed: true, types: [...types] } : { typed: false };
  const { subtotal, tax, total } = priceInvoiceVat(safe, vat, invoiceDate, amountsAre).header;
  return { subtotal, tax, total };
}
