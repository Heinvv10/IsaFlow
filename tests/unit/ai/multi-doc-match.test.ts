/**
 * TDD: Multi-Document Match (PO ↔ GRN ↔ Invoice)
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDocumentRole,
  performMultiDocMatch,
  buildCrossReferenceReport,
  findDiscrepancies,
  type DocumentRole,
  type MultiDocMatchInput,
  type MultiDocMatchResult,
} from '@/modules/accounting/services/multiDocMatchService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDoc(overrides: Partial<ExtractedDocument>): ExtractedDocument {
  return {
    documentType: 'invoice',
    vendorName: 'Acme Suppliers (Pty) Ltd',
    vendorVatNumber: null,
    vendorAddress: null,
    vendorBankDetails: null,
    customerName: 'ISAFlow Demo',
    customerVatNumber: null,
    date: '2026-03-01',
    dueDate: null,
    paymentTerms: null,
    referenceNumber: 'INV-001',
    purchaseOrderRef: 'PO-2026-001',
    currency: 'ZAR',
    subtotal: 10000,
    vatAmount: 1500,
    vatRate: 15,
    totalAmount: 11500,
    lineItems: [
      { description: 'Widget A', quantity: 10, unitPrice: 1000, total: 10000, vatAmount: 1500, vatClassification: 'standard', glAccountSuggestion: null },
    ],
    rawText: 'INV-001',
    confidence: 0.9,
    warnings: [],
    extractionMethod: 'vlm',
    ...overrides,
  };
}

const poDoc: ExtractedDocument = makeDoc({
  documentType: 'purchase_order',
  referenceNumber: 'PO-2026-001',
  purchaseOrderRef: null,
  rawText: 'PO-2026-001 Purchase Order',
});

const grnDoc: ExtractedDocument = makeDoc({
  documentType: 'delivery_note',
  referenceNumber: 'GRN-2026-001',
  purchaseOrderRef: 'PO-2026-001',
  rawText: 'GRN-2026-001 Goods Received Note',
});

const invoiceDoc: ExtractedDocument = makeDoc({
  documentType: 'invoice',
  referenceNumber: 'INV-2026-001',
  purchaseOrderRef: 'PO-2026-001',
});

// ---------------------------------------------------------------------------
// classifyDocumentRole
// ---------------------------------------------------------------------------

describe('classifyDocumentRole', () => {
  it('classifies PO by document number pattern', () => {
    const result = classifyDocumentRole(poDoc);
    expect(result.role).toBe<DocumentRole>('purchase_order');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('classifies delivery note by GRN/DN pattern', () => {
    const result = classifyDocumentRole(grnDoc);
    expect(result.role).toBe<DocumentRole>('delivery_note');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('classifies invoice by INV pattern', () => {
    const result = classifyDocumentRole(invoiceDoc);
    expect(result.role).toBe<DocumentRole>('invoice');
    expect(result.confidence).toBeGreaterThan(0.7);
  });

  it('classifies by document type field when no reference pattern matches', () => {
    const doc = makeDoc({ documentType: 'purchase_order', referenceNumber: 'DOC-999', rawText: 'DOC-999' });
    const result = classifyDocumentRole(doc);
    expect(result.role).toBe<DocumentRole>('purchase_order');
  });
});

// ---------------------------------------------------------------------------
// performMultiDocMatch
// ---------------------------------------------------------------------------

describe('performMultiDocMatch', () => {
  it('performs full 3-way match with matching docs', () => {
    const input: MultiDocMatchInput = { documents: [poDoc, grnDoc, invoiceDoc] };
    const result = performMultiDocMatch(input);
    expect(result.matchStatus).toBe('full_match');
    expect(result.overallConfidence).toBeGreaterThan(0.7);
  });

  it('detects partial match when amounts differ', () => {
    const altInvoice = makeDoc({
      documentType: 'invoice',
      referenceNumber: 'INV-2026-002',
      purchaseOrderRef: 'PO-2026-001',
      totalAmount: 13000, // higher than PO
      subtotal: 11304,
    });
    const input: MultiDocMatchInput = { documents: [poDoc, grnDoc, altInvoice] };
    const result = performMultiDocMatch(input);
    expect(result.matchStatus).toBe('partial_match');
  });

  it('detects unmatched when vendor names differ', () => {
    const altInvoice = makeDoc({
      documentType: 'invoice',
      referenceNumber: 'INV-2026-003',
      vendorName: 'Totally Different Vendor',
      purchaseOrderRef: 'PO-2026-001',
    });
    const input: MultiDocMatchInput = { documents: [poDoc, grnDoc, altInvoice] };
    const result = performMultiDocMatch(input);
    expect(result.matchStatus).toBe('unmatched');
  });

  it('handles only 2 of 3 documents', () => {
    const input: MultiDocMatchInput = { documents: [poDoc, invoiceDoc] };
    const result = performMultiDocMatch(input);
    expect(result.matchStatus).not.toBe('full_match');
    expect(result.missingDocuments.length).toBeGreaterThan(0);
  });

  it('calculates overall confidence', () => {
    const input: MultiDocMatchInput = { documents: [poDoc, grnDoc, invoiceDoc] };
    const result = performMultiDocMatch(input);
    expect(result.overallConfidence).toBeGreaterThanOrEqual(0);
    expect(result.overallConfidence).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// buildCrossReferenceReport
// ---------------------------------------------------------------------------

describe('buildCrossReferenceReport', () => {
  it('builds cross-reference report for matching docs', () => {
    const refs = buildCrossReferenceReport(poDoc, grnDoc, invoiceDoc);
    expect(Array.isArray(refs)).toBe(true);
    expect(refs.length).toBeGreaterThan(0);
  });

  it('identifies quantity discrepancies', () => {
    const altGrn = makeDoc({
      documentType: 'delivery_note',
      referenceNumber: 'GRN-2026-002',
      lineItems: [
        { description: 'Widget A', quantity: 8, unitPrice: 1000, total: 8000, vatAmount: 1200, vatClassification: 'standard', glAccountSuggestion: null },
      ],
    });
    const refs = buildCrossReferenceReport(poDoc, altGrn, invoiceDoc);
    const qtyRef = refs.find(r => r.field === 'quantity');
    expect(qtyRef).toBeDefined();
    expect(qtyRef!.matched).toBe(false);
  });

  it('identifies price discrepancies', () => {
    const altInvoice = makeDoc({
      documentType: 'invoice',
      referenceNumber: 'INV-2026-004',
      lineItems: [
        { description: 'Widget A', quantity: 10, unitPrice: 1200, total: 12000, vatAmount: 1800, vatClassification: 'standard', glAccountSuggestion: null },
      ],
      subtotal: 12000,
      totalAmount: 13800,
    });
    const refs = buildCrossReferenceReport(poDoc, grnDoc, altInvoice);
    const priceRef = refs.find(r => r.field === 'unitPrice');
    expect(priceRef).toBeDefined();
    expect(priceRef!.matched).toBe(false);
  });

  it('handles empty line items gracefully', () => {
    const emptyPo = makeDoc({ documentType: 'purchase_order', lineItems: [] });
    const emptyGrn = makeDoc({ documentType: 'delivery_note', lineItems: [] });
    const emptyInv = makeDoc({ documentType: 'invoice', lineItems: [] });
    expect(() => buildCrossReferenceReport(emptyPo, emptyGrn, emptyInv)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// findDiscrepancies
// ---------------------------------------------------------------------------

describe('findDiscrepancies', () => {
  it('assigns correct severity levels', () => {
    const refs = buildCrossReferenceReport(poDoc, grnDoc, invoiceDoc);
    const discrepancies = findDiscrepancies(refs, [poDoc, grnDoc, invoiceDoc]);
    // no discrepancies on perfect match
    const errors = discrepancies.filter(d => d.severity === 'error');
    expect(errors.length).toBe(0);
  });

  it('flags price discrepancy as error severity', () => {
    const altInvoice = makeDoc({
      documentType: 'invoice',
      referenceNumber: 'INV-2026-005',
      lineItems: [
        { description: 'Widget A', quantity: 10, unitPrice: 1500, total: 15000, vatAmount: 2250, vatClassification: 'standard', glAccountSuggestion: null },
      ],
      subtotal: 15000,
      totalAmount: 17250,
    });
    const refs = buildCrossReferenceReport(poDoc, grnDoc, altInvoice);
    const discrepancies = findDiscrepancies(refs, [poDoc, grnDoc, altInvoice]);
    expect(discrepancies.some(d => d.severity === 'error')).toBe(true);
  });
});
