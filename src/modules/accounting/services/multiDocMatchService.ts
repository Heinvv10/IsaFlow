/**
 * Multi-Document Match Service
 * Pure business logic — cross-matches PO, GRN, and Invoice documents.
 * No database dependencies.
 */

import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { fuzzyMatchSupplier } from '@/modules/accounting/utils/fuzzyMatch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type DocumentRole = 'purchase_order' | 'delivery_note' | 'invoice';

export type MatchStatus = 'full_match' | 'partial_match' | 'unmatched';

export interface DocumentClassification {
  role: DocumentRole;
  confidence: number;
}

export interface CrossReference {
  field: string;
  poValue: unknown;
  grnValue: unknown;
  invoiceValue: unknown;
  matched: boolean;
}

export interface MatchDiscrepancy {
  field: string;
  expected: unknown;
  actual: unknown;
  severity: 'error' | 'warning';
  message: string;
}

export interface MultiDocMatchInput {
  documents: ExtractedDocument[];
}

export interface MultiDocMatchResult {
  matchStatus: MatchStatus;
  overallConfidence: number;
  classifiedDocuments: Array<{ document: ExtractedDocument; role: DocumentRole; confidence: number }>;
  missingDocuments: DocumentRole[];
  crossReferences: CrossReference[];
  discrepancies: MatchDiscrepancy[];
}

// ---------------------------------------------------------------------------
// Reference number patterns
// ---------------------------------------------------------------------------

const PO_PATTERNS = [/\bPO[-_]?\d/i, /\bpurchase.?order\b/i, /\bPURCH/i];
const GRN_PATTERNS = [/\bGRN[-_]?\d/i, /\bDN[-_]?\d/i, /\bdelivery.?note\b/i, /\bgoods.?receiv/i];
const INV_PATTERNS = [/\bINV[-_]?\d/i, /\bFAKTUUR\b/i, /\bINVOICE\b/i, /\bTAX.?INVOICE\b/i];

function matchesAny(text: string, patterns: RegExp[]): boolean {
  return patterns.some(p => p.test(text));
}

// ---------------------------------------------------------------------------
// classifyDocumentRole
// ---------------------------------------------------------------------------

export function classifyDocumentRole(doc: ExtractedDocument): DocumentClassification {
  const ref = doc.referenceNumber || '';
  const raw = doc.rawText || '';
  const combined = `${ref} ${raw}`;

  // Pattern-based classification has priority
  if (matchesAny(combined, PO_PATTERNS)) {
    return { role: 'purchase_order', confidence: 0.9 };
  }
  if (matchesAny(combined, GRN_PATTERNS)) {
    return { role: 'delivery_note', confidence: 0.9 };
  }
  if (matchesAny(combined, INV_PATTERNS)) {
    return { role: 'invoice', confidence: 0.85 };
  }

  // Fall back to documentType field
  if (doc.documentType === 'purchase_order') {
    return { role: 'purchase_order', confidence: 0.75 };
  }
  if (doc.documentType === 'delivery_note') {
    return { role: 'delivery_note', confidence: 0.75 };
  }
  if (doc.documentType === 'invoice') {
    return { role: 'invoice', confidence: 0.75 };
  }

  // Default to invoice as most common
  return { role: 'invoice', confidence: 0.4 };
}

// ---------------------------------------------------------------------------
// buildCrossReferenceReport
// ---------------------------------------------------------------------------

export function buildCrossReferenceReport(
  po: ExtractedDocument,
  grn: ExtractedDocument,
  invoice: ExtractedDocument,
): CrossReference[] {
  const refs: CrossReference[] = [];

  // Vendor name cross-check
  refs.push({
    field: 'vendorName',
    poValue: po.vendorName,
    grnValue: grn.vendorName,
    invoiceValue: invoice.vendorName,
    matched: vendorNamesMatch(po.vendorName, grn.vendorName, invoice.vendorName),
  });

  // Total amount
  refs.push({
    field: 'totalAmount',
    poValue: po.totalAmount,
    grnValue: grn.totalAmount,
    invoiceValue: invoice.totalAmount,
    matched: amountsMatch(po.totalAmount, invoice.totalAmount),
  });

  // PO reference cross-check (GRN and Invoice should reference the PO)
  refs.push({
    field: 'purchaseOrderRef',
    poValue: po.referenceNumber,
    grnValue: grn.purchaseOrderRef,
    invoiceValue: invoice.purchaseOrderRef,
    matched:
      (grn.purchaseOrderRef != null && grn.purchaseOrderRef === po.referenceNumber) ||
      (invoice.purchaseOrderRef != null && invoice.purchaseOrderRef === po.referenceNumber),
  });

  // Line item cross-checks
  const poItems = po.lineItems ?? [];
  const grnItems = grn.lineItems ?? [];
  const invItems = invoice.lineItems ?? [];

  if (poItems.length > 0 && invItems.length > 0) {
    const poQty = sumField(poItems, 'quantity');
    const grnQty = sumField(grnItems, 'quantity');
    const invQty = sumField(invItems, 'quantity');

    refs.push({
      field: 'quantity',
      poValue: poQty,
      grnValue: grnQty,
      invoiceValue: invQty,
      matched: poQty === invQty && (grnItems.length === 0 || grnQty === invQty),
    });

    const poUnitPrice = avgField(poItems, 'unitPrice');
    const invUnitPrice = avgField(invItems, 'unitPrice');
    refs.push({
      field: 'unitPrice',
      poValue: poUnitPrice,
      grnValue: null,
      invoiceValue: invUnitPrice,
      matched: unitPricesMatch(poUnitPrice, invUnitPrice),
    });
  }

  return refs;
}

// ---------------------------------------------------------------------------
// findDiscrepancies
// ---------------------------------------------------------------------------

export function findDiscrepancies(
  crossRefs: CrossReference[],
  _docs: ExtractedDocument[],
): MatchDiscrepancy[] {
  const discrepancies: MatchDiscrepancy[] = [];

  for (const ref of crossRefs) {
    if (ref.matched) continue;

    const severity = ref.field === 'vendorName' || ref.field === 'unitPrice' || ref.field === 'totalAmount'
      ? 'error'
      : 'warning';

    discrepancies.push({
      field: ref.field,
      expected: ref.poValue,
      actual: ref.invoiceValue,
      severity,
      message: `${ref.field} mismatch: PO=${JSON.stringify(ref.poValue)}, Invoice=${JSON.stringify(ref.invoiceValue)}`,
    });
  }

  return discrepancies;
}

// ---------------------------------------------------------------------------
// performMultiDocMatch
// ---------------------------------------------------------------------------

export function performMultiDocMatch(input: MultiDocMatchInput): MultiDocMatchResult {
  const { documents } = input;

  // Classify each document
  const classified = documents.map(doc => ({
    document: doc,
    ...classifyDocumentRole(doc),
  }));

  const po = classified.find(c => c.role === 'purchase_order');
  const grn = classified.find(c => c.role === 'delivery_note');
  const invoice = classified.find(c => c.role === 'invoice');

  const missingDocuments: DocumentRole[] = [];
  if (!po) missingDocuments.push('purchase_order');
  if (!grn) missingDocuments.push('delivery_note');
  if (!invoice) missingDocuments.push('invoice');

  // Need at least PO + invoice to run a match
  if (!po || !invoice) {
    return {
      matchStatus: 'unmatched',
      overallConfidence: 0,
      classifiedDocuments: classified,
      missingDocuments,
      crossReferences: [],
      discrepancies: [],
    };
  }

  const grnDoc = grn?.document ?? makeEmptyDoc('delivery_note');
  const crossReferences = buildCrossReferenceReport(po.document, grnDoc, invoice.document);
  const discrepancies = findDiscrepancies(crossReferences, documents);

  const errorCount = discrepancies.filter(d => d.severity === 'error').length;
  const matchedCount = crossReferences.filter(r => r.matched).length;
  const totalChecks = crossReferences.length;

  const hasVendorError = discrepancies.some(d => d.field === 'vendorName' && d.severity === 'error');

  let matchStatus: MatchStatus;
  if (hasVendorError) {
    matchStatus = 'unmatched';
  } else if (errorCount === 0 && missingDocuments.length === 0) {
    matchStatus = 'full_match';
  } else if (errorCount === 0 || matchedCount / totalChecks >= 0.5) {
    matchStatus = 'partial_match';
  } else {
    matchStatus = 'unmatched';
  }

  const classificationConfidence =
    classified.reduce((sum, c) => sum + c.confidence, 0) / classified.length;
  const matchConfidence = totalChecks > 0 ? matchedCount / totalChecks : 0;
  const overallConfidence = Math.round(((classificationConfidence + matchConfidence) / 2) * 100) / 100;

  return {
    matchStatus,
    overallConfidence,
    classifiedDocuments: classified,
    missingDocuments,
    crossReferences,
    discrepancies,
  };
}

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function makeEmptyDoc(type: ExtractedDocument['documentType']): ExtractedDocument {
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

function vendorNamesMatch(a: string | null, b: string | null, c: string | null): boolean {
  const names = [a, b, c].filter((n): n is string => n != null);
  if (names.length < 2) return true; // not enough data to fail

  const candidates = names.map(n => ({ id: n, name: n }));
  // All names should fuzzy-match the first one
  return names.slice(1).every(name => {
    const match = fuzzyMatchSupplier(names[0]!, candidates, 0.55);
    return match !== null && fuzzyMatchSupplier(name, [{ id: names[0]!, name: names[0]! }], 0.55) !== null;
  });
}

function amountsMatch(a: number | null, b: number | null, tolerancePct = 2): boolean {
  if (a == null || b == null) return true;
  if (a === 0 && b === 0) return true;
  const base = Math.max(Math.abs(a), Math.abs(b));
  return (Math.abs(a - b) / base) * 100 <= tolerancePct;
}

function unitPricesMatch(a: number | null, b: number | null, tolerancePct = 2): boolean {
  return amountsMatch(a, b, tolerancePct);
}

type LineItemKey = 'quantity' | 'unitPrice' | 'total';

function sumField(items: ExtractedDocument['lineItems'], field: LineItemKey): number {
  return items.reduce((sum, item) => sum + (item[field] ?? 0), 0);
}

function avgField(items: ExtractedDocument['lineItems'], field: LineItemKey): number | null {
  const vals = items.map(i => i[field]).filter((v): v is number => v != null);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}
