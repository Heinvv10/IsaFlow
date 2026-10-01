/**
 * Line and document totals for a supplier invoice — the ONE place the rounding
 * rules live. Create and the draft update both write these figures, and the
 * approval journal is built from them, so a second copy that rounded
 * differently would leave a bill disagreeing with its own journal.
 *
 * Pure: no database, no logging side effects beyond the 0% warning.
 */
import { log } from '@/lib/logger';
import type {
  SupplierInvoiceItemInput,
  SupplierInvoiceImportItemInput,
} from '../../types/ap.types';

export interface ComputedSupplierInvoiceItem extends SupplierInvoiceItemInput {
  lineTotal: number;
  taxAmount: number;
  taxRate: number;
}

export interface SupplierInvoiceTotals {
  items: ComputedSupplierInvoiceItem[];
  subtotal: number;
  totalTax: number;
  totalAmount: number;
}

/** The importer-only exact tax on a line, or undefined on a public input. */
const lineTax = (item: SupplierInvoiceItemInput): number | undefined =>
  (item as SupplierInvoiceImportItemInput).taxAmount;

/**
 * Refuse lines that would produce a negative document (W1, P2.1). Throws a
 * plain Error naming the line; callers run it before their first write.
 */
export function assertSupplierInvoiceLines(
  items: readonly SupplierInvoiceItemInput[],
  trustSourceTax: boolean,
): void {
  for (const item of items) {
    if (!(Number(item.quantity) > 0)) {
      throw new Error(`Line "${item.description}": quantity must be positive`);
    }
    if (Number(item.unitPrice) < 0) {
      throw new Error(`Line "${item.description}": unit price cannot be negative`);
    }
    if (trustSourceTax && lineTax(item) !== undefined
        && !(Number.isFinite(Number(lineTax(item))) && Number(lineTax(item)) >= 0)) {
      throw new Error(`Line "${item.description}": tax amount must be a non-negative number`);
    }
  }
}

export function computeSupplierInvoiceTotals(
  items: readonly SupplierInvoiceItemInput[],
  invoiceTaxRate: number,
  trustSourceTax: boolean,
): SupplierInvoiceTotals {
  let subtotal = 0;
  let totalTax = 0;

  const computed = items.map((item) => {
    const lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
    const itemTaxRate = item.taxRate ?? invoiceTaxRate;
    // An importer may supply the source system's exact tax; deriving it from
    // the rounded rate is what makes a migrated row disagree with its journal.
    // Gated on trustSourceTax so a request body can never reach this branch.
    const sourceTax = trustSourceTax ? lineTax(item) : undefined;
    const itemTax = sourceTax !== undefined
      ? Math.round(Number(sourceTax) * 100) / 100
      : Math.round(lineTotal * itemTaxRate / 100 * 100) / 100;
    // Warn when a 0% line has no explicit vatClassification — exempt and zero-rated
    // both have 0% rate but differ in input VAT recoverability under the VAT Act.
    if (itemTaxRate === 0 && !item.vatClassification) {
      log.warn('Supplier invoice line has 0% VAT with no vatClassification — defaulting to zero_rated; set vatClassification=exempt explicitly for exempt supplies', { description: item.description }, 'accounting');
    }
    subtotal += lineTotal;
    totalTax += itemTax;
    return { ...item, lineTotal, taxAmount: itemTax, taxRate: itemTaxRate };
  });

  subtotal = Math.round(subtotal * 100) / 100;
  totalTax = Math.round(totalTax * 100) / 100;
  return { items: computed, subtotal, totalTax, totalAmount: subtotal + totalTax };
}

/** The vat_classification a line gets when none is given — create's default. */
export function defaultVatClassification(taxRate: number): 'standard' | 'zero_rated' {
  return taxRate > 0 ? 'standard' : 'zero_rated';
}
