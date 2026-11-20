/**
 * The new and edit invoice pages' VAT, until the line-level VAT screen: the form's one rate types every line as the
 * server's legacy header contract does (invoiceLineVatTypes): the standard rate on the invoice date -> standard, 0 ->
 * zero_rated. The totals are the shared per-line pricing (invoiceLineVatPricing), so the summary shows the figure create
 * and the draft edit store. A rate that is neither (the server refuses it, saying why) is shown as VAT on the subtotal at
 * that rate, as typed. A company not registered for VAT prices at no VAT ('none'), as the server forces it.
 *
 * Pure but for `useVatMode` (the active company's registration): safe in a client bundle.
 */
import { isRatedDate, standardVatRatePctOn } from '@/lib/vat/standardRate';
import { previewLineAmount, previewTotals } from '@/modules/accounting/services/ar/invoiceLineAmount';
import { previewInvoiceVat, type AmountsAre } from '@/modules/accounting/services/ar/invoiceLineVatPricing';
import type { DocumentLineVatType } from '@/modules/accounting/services/ar/invoiceLineVatTypes';
import { useVatRegistrationOrDefault } from '@/hooks/useVatRegistration';
import type { TaxMode } from './taxMode';

interface FormLine { quantity: number; unitPrice: number; discount?: number }

/** The mode the form prices and sends in: 'none' for a company not registered for VAT, whatever is picked. */
export const vatModeFor = (registered: boolean, picked: TaxMode): TaxMode => (registered ? picked : 'none');

/** vatModeFor for the active company (a registered vendor outside a CompanyProvider, useVatRegistrationOrDefault). */
export const useVatMode = (picked: TaxMode): TaxMode => vatModeFor(useVatRegistrationOrDefault().isRegistered, picked);

/** The one type the form's rate gives every line on `date`, or null for a rate that is neither the standard rate nor 0. */
export function formLineType(rate: number, date: string): DocumentLineVatType | null {
  if (rate === 0) return 'zero_rated';
  return isRatedDate(date) && rate === standardVatRatePctOn(date) ? 'standard' : null;
}

/** The summary's totals over lines whose `unitPrice` is the one sent (see the header). */
export function formTotals(lines: readonly FormLine[], rate: number, date: string, amountsAre: AmountsAre = 'exclusive'): { subtotal: number; tax: number; total: number } {
  const type = formLineType(rate, date);
  if (type === null) return previewTotals(lines.map((l) => previewLineAmount(l.quantity, l.unitPrice, l.discount || 0)), rate);
  return previewInvoiceVat(lines, lines.map(() => type), date, amountsAre);
}
