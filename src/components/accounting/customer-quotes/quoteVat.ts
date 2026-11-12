/**
 * The quote form's VAT: the invoice form's "Amounts are" mode and one rate per document (taxMode.ts), priced by the
 * same functions the invoice preview uses (invoiceLineAmount.ts), so a quote shows what an invoice of it would.
 *
 * Pure: safe in a client bundle.
 */
import { effectiveTaxRate, lineTotalForMode, linesForModeChange, storedUnitPrice, type TaxMode } from '@/components/accounting/customer-invoices/taxMode';
import { previewTotals, type InvoiceTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import type { VatRegistration } from '@/hooks/vatRegistrationState';

export interface QuoteFormLine { qty: number; price: number }

/** The form's lines once the mode changes: shown prices convert, as on the invoice form. */
export const quoteLinesForModeChange = <L extends QuoteFormLine>(lines: readonly L[], from: TaxMode, to: TaxMode, formRate: number): L[] =>
  linesForModeChange(lines.map((l) => ({ ...l, unitPrice: l.price })), from, to, formRate).map((c, i) => ({ ...lines[i]!, price: c.unitPrice }));

/** No VAT for a company known not to be a VAT vendor; otherwise Excluding VAT, as the invoice form starts. */
export const initialQuoteTaxMode = (reg: VatRegistration): TaxMode => (reg.known && !reg.isRegistered ? 'none' : 'exclusive');

/** The line's stored ex-VAT amount for what was typed. */
export const quoteLineTotal = (l: QuoteFormLine, mode: TaxMode, formRate: number): number =>
  lineTotalForMode(mode, effectiveTaxRate(mode, formRate), { quantity: l.qty, unitPrice: l.price, discount: 0 });

export const quoteTotals = (lines: readonly QuoteFormLine[], mode: TaxMode, formRate: number): InvoiceTotals =>
  previewTotals(lines.map((l) => quoteLineTotal(l, mode, formRate)), effectiveTaxRate(mode, formRate));

/** What the API receives for a line: the ex-VAT unit price and the rate it is taxed at. */
export function quoteLinePayload(l: QuoteFormLine, mode: TaxMode, formRate: number): { unitPrice: number; taxRate: number } {
  const taxRate = effectiveTaxRate(mode, formRate);
  return { unitPrice: storedUnitPrice(mode, l.price, taxRate), taxRate };
}
