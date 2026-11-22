/**
 * The quote PDF's line table and VAT rows (quotePdfBuilder), with the figures as STORED.
 *
 *   TYPED quote (every line carries vat_type and tax_amount, migration 1024): the invoice PDF's typed table
 *     (invoicePdfTypedLines: each line's type and its stored VAT, unit price headed incl. / excl. by `amounts_are`), and
 *     in the totals one VAT row per type when the lines mix types ("VAT Standard (15%) on R100.00"), each the sum of its
 *     lines' stored VAT; one row when they do not.
 *   LEGACY quote: the rate table as before, the VAT label stating the rate the lines carry, and the disagreement between
 *     the header VAT and the lines' rates printed and logged.
 * A typed quote whose lines' VAT does not foot to its header (nothing writes one: quoteLineTax prices the header from the
 * lines) is printed with the same note. Pure.
 */
import { fmtZAR } from '../core/pdfShared';
import { vatTypeLabel } from '../shared/vatTypes';
import { exactCents } from '../shared/vatLineAmounts';
import { storedVatType } from './invoiceVatLegs';
import { typedInvoicePdfTable } from './invoicePdfTypedLines';
import type { VatType } from '../../types/gl.types';

type Row = Record<string, unknown>;

export interface QuotePdfVat {
  head: string[];
  body: string[][];
  typed: boolean;
  /** The totals block's VAT rows, in the order the types first appear on the lines. */
  vatRows: { label: string; value: string }[];
  /** Header VAT less what the lines account for, to the cent; 0 when they agree. */
  disagreement: number;
}

/** Per VAT type in first-appearance order, the stored net and VAT of its lines (exact cents). */
export function quoteVatByType(lines: readonly Row[]): { type: VatType; net: number; vat: number }[] {
  const out = new Map<VatType, { net: number; vat: number }>();
  for (const l of lines) {
    const t = storedVatType(l.vat_type)!;
    const s = out.get(t) ?? { net: 0, vat: 0 };
    out.set(t, { net: s.net + exactCents(Number(l.amount || 0)), vat: s.vat + exactCents(Number(l.tax_amount || 0)) });
  }
  return [...out].map(([type, s]) => ({ type, net: s.net / 100, vat: s.vat / 100 }));
}

function legacy(q: Row, lines: readonly Row[]): QuotePdfVat {
  const headerTaxRate = Number(q.tax_rate ?? 15);
  const lineRate = (line: Row): number => (line.tax_rate != null ? Number(line.tax_rate) : headerTaxRate);
  // As in invoicePdfBuilder: state the rate the LINES carry. Uniform zero-rated lines under a header still holding the
  // 15.00 column default must not be labelled 'VAT (15%)'.
  const distinctRates = [...new Set(lines.map(lineRate))];
  const label = distinctRates.length === 1
    ? `VAT (${distinctRates[0]}%)`
    : distinctRates.length === 0 ? `VAT (${headerTaxRate}%)` : 'VAT';
  // The table prints a RATE per line, not a VAT amount, so there is no column to foot. What can still disagree is the
  // stored header aggregate: a quote whose lines are all zero-rated but whose `tax_amount` still holds a 15% figure
  // prints 'VAT (0%) R150.00'. The tolerance is a HALF CENT, not `lines.length / 100`: nothing on this page rounds per
  // line, so a line-scaled tolerance only silenced up to R0.20 of real disagreement on a 20-line quote.
  const headerVat = Number(q.tax_amount || 0);
  const linesVat = lines.reduce((sum, line) => sum + Number(line.amount || 0) * (lineRate(line) / 100), 0);
  return {
    head: ['Description', 'Qty', 'Unit Price', 'VAT Rate', 'Amount'],
    body: lines.map((line) => [
      String(line.description || '—'), Number(line.quantity || 0).toFixed(2), fmtZAR(Number(line.unit_price || 0)),
      `${lineRate(line).toFixed(0)}%`, fmtZAR(Number(line.amount || 0)),
    ]),
    typed: false,
    vatRows: [{ label, value: fmtZAR(headerVat) }],
    disagreement: Math.round((headerVat - linesVat) * 100) / 100,
  };
}

export function quotePdfVat(q: Row, lines: readonly Row[]): QuotePdfVat {
  const table = typedInvoicePdfTable(lines as never, { invoice_date: q.quote_date, subtotal: q.subtotal, tax_amount: q.tax_amount, amounts_are: q.amounts_are });
  if (!table) return legacy(q, lines);
  const headerVat = Number(q.tax_amount || 0);
  const byType = quoteVatByType(lines);
  const vatRows = byType.length === 1
    ? [{ label: table.vatLabel, value: fmtZAR(headerVat) }]
    : byType.map((t) => ({ label: `VAT ${vatTypeLabel(t.type, q.quote_date as string | Date)} on ${fmtZAR(t.net)}`, value: fmtZAR(t.vat) }));
  const linesVat = byType.reduce((s, t) => s + exactCents(t.vat), 0);
  return { head: table.head, body: table.body, typed: true, vatRows, disagreement: (exactCents(headerVat) - linesVat) / 100 };
}
