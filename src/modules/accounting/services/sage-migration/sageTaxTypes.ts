/**
 * Sage tax type ids -> IsaFlow VAT types and rates. ASSUMED table (Sage SA, Business Cloud Accounting): 1 standard 15%,
 * 2 zero-rated 0%, 3 exempt 0%. An id not in it is REFUSED (`unknown_tax_type`), never guessed: a wrong VAT type on an item or
 * a wrong rate on a PO line is a real defect, a refused row is a fixed file.
 */
import type { SageTaxType } from './sageExportTypes';

export const SAGE_TAX_TYPES: Readonly<Record<string, { vat: SageTaxType; rate: number }>> = {
  '1': { vat: 'standard', rate: 15 },
  '2': { vat: 'zero', rate: 0 },
  '3': { vat: 'exempt', rate: 0 },
};

export function taxTypeFor(id: string): { vat: SageTaxType; rate: number } | null {
  return Object.hasOwn(SAGE_TAX_TYPES, id) ? SAGE_TAX_TYPES[id]! : null;
}
