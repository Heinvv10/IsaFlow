/**
 * Multi-Document Match Helpers
 * Private utility functions extracted from multiDocMatchService.ts.
 * Not intended for direct external use.
 */

import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { fuzzyMatchSupplier } from '@/modules/accounting/utils/fuzzyMatch';

export function makeEmptyDoc(type: ExtractedDocument['documentType']): ExtractedDocument {
  return {
    documentType: type,
    vendorName: null,
    vendorVatNumber: null,
    vendorAddress: null,
    vendorBankDetails: null,
    customerName: null,
    customerVatNumber: null,
    date: null,
    dueDate: null,
    paymentTerms: null,
    referenceNumber: null,
    purchaseOrderRef: null,
    currency: null,
    subtotal: null,
    vatAmount: null,
    vatRate: null,
    totalAmount: null,
    lineItems: [],
    rawText: '',
    confidence: 0,
    warnings: [],
    extractionMethod: 'vlm',
  };
}

export function vendorNamesMatch(a: string | null, b: string | null, c: string | null): boolean {
  const names = [a, b, c].filter((n): n is string => n != null);
  if (names.length < 2) return true; // not enough data to fail

  const candidates = names.map(n => ({ id: n, name: n }));
  // All names should fuzzy-match the first one
  return names.slice(1).every(name => {
    const match = fuzzyMatchSupplier(names[0]!, candidates, 0.55);
    return match !== null && fuzzyMatchSupplier(name, [{ id: names[0]!, name: names[0]! }], 0.55) !== null;
  });
}

export function amountsMatch(a: number | null, b: number | null, tolerancePct = 2): boolean {
  if (a == null || b == null) return true;
  if (a === 0 && b === 0) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return (Math.abs(a - b) / base) * 100 <= tolerancePct;
}

export function unitPricesMatch(a: number | null, b: number | null, tolerancePct = 2): boolean {
  return amountsMatch(a, b, tolerancePct);
}

type LineItemKey = 'quantity' | 'unitPrice' | 'total';

export function sumField(items: ExtractedDocument['lineItems'], field: LineItemKey): number {
  return items.reduce((sum, item) => sum + (item[field] ?? 0), 0);
}

export function avgField(items: ExtractedDocument['lineItems'], field: LineItemKey): number | null {
  const vals = items.map(i => i[field]).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
