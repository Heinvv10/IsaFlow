/**
 * Sage tax type ids -> IsaFlow VAT types and rates. ASSUMED table (Sage SA, Business Cloud Accounting): 1 standard, 2 zero-rated
 * 0%, 3 exempt 0%. An id not in it is REFUSED (`unknown_tax_type`), never guessed: a wrong VAT type on an item or a wrong rate
 * on a PO line is a real defect, a refused row is a fixed file.
 *
 * The standard rate is the one that applied on the document's date (`standardVatRatePctOn`: 14% before 2018-04-01, 15% from then
 * on). A line's percentage must be that rate or 0 (sagePurchaseOrderParser).
 */
import { standardVatRatePctOn } from '@/lib/vat/standardRate';
import type { SageTaxType } from './sageExportTypes';

/** The standard VAT rate on `date` (YYYY-MM-DD); throws VatRateDateError for a date no rate can be read for. */
export const standardRateOn = standardVatRatePctOn;

const TYPES: Readonly<Record<string, SageTaxType>> = { '1': 'standard', '2': 'zero', '3': 'exempt' };

/** The VAT type of a Sage tax type id, or null when it is not one this migration knows. */
export function taxTypeFor(id: string): { vat: SageTaxType } | null {
  return Object.hasOwn(TYPES, id) ? { vat: TYPES[id]! } : null;
}

/** The rate a tax type carries on `date`. */
export const rateOf = (vat: SageTaxType, date: string): number => (vat === 'standard' ? standardRateOn(date) : 0);
