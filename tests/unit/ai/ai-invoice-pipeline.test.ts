/**
 * TDD: AI Invoice Pipeline — Capture → Invoice → GL
 */

import { describe, it, expect } from 'vitest';
import {
  validatePipelineInput,
  matchSupplierFromExtraction,
  buildInvoiceFromExtraction,
  determineApprovalRoute,
  computePipelineConfidence,
  type PipelineThresholds,
} from '@/modules/accounting/services/core/aiInvoicePipelineService';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';

const makeExtracted = (overrides?: Partial<ExtractedDocument>): ExtractedDocument => ({
  documentType: 'invoice',
  vendorName: 'Makro SA (Pty) Ltd',
  vendorVatNumber: '4100000001',
  vendorAddress: '123 Makro Drive',
  vendorBankDetails: null,
  customerName: null,
  customerVatNumber: null,
  date: '2026-03-15',
  dueDate: '2026-04-14',
  paymentTerms: 'net30',
  referenceNumber: 'MKR-2026-0999',
  purchaseOrderRef: 'PO-2026-010',
  currency: 'ZAR',
  subtotal: 8695.65,
  vatAmount: 1304.35,
  vatRate: 15,
  totalAmount: 10000.00,
  lineItems: [
    { description: 'Office supplies', quantity: 10, unitPrice: 869.57, total: 8695.65, vatAmount: null, vatClassification: null, glAccountSuggestion: null },
  ],
  rawText: '',
  confidence: 0.92,
  warnings: [],
  extractionMethod: 'vlm',
  ...overrides,
});

const suppliers = [
  { id: 'sup-001', name: 'Makro SA (Pty) Ltd' },
  { id: 'sup-002', name: 'Builders Warehouse' },
  { id: 'sup-003', name: 'Telkom SA SOC Ltd' },
];

describe('Pipeline Input Validation', () => {
  it('rejects extracted document with no totalAmount', () => {
    const r = validatePipelineInput(makeExtracted({ totalAmount: null }));
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('totalAmount is required');
  });

  it('rejects extracted document with no vendorName', () => {
    const r = validatePipelineInput(makeExtracted({ vendorName: null }));
    expect(r.valid).toBe(false);
    expect(r.errors).toContain('vendorName is required');
  });

  it('accepts valid extracted document', () => {
    const r = validatePipelineInput(makeExtracted());
    expect(r.valid).toBe(true);
    expect(r.errors.length).toBe(0);
  });

  it('flags missing lineItems as warning not error', () => {
    const r = validatePipelineInput(makeExtracted({ lineItems: [] }));
    expect(r.valid).toBe(true);
    expect(r.warnings).toContain('No line items extracted');
  });
});

describe('Supplier Matching from Extraction', () => {
  it('matches exact supplier name', () => {
    const m = matchSupplierFromExtraction(makeExtracted(), suppliers);
    expect(m).not.toBeNull();
    expect(m!.supplierId).toBe('sup-001');
  });

  it('matches partial name (strips Pty/Ltd)', () => {
    const m = matchSupplierFromExtraction(makeExtracted({ vendorName: 'Makro SA' }), suppliers);
    expect(m).not.toBeNull();
    expect(m!.supplierId).toBe('sup-001');
  });

  it('returns null when no supplier matches', () => {
    const m = matchSupplierFromExtraction(makeExtracted({ vendorName: 'Unknown Corp' }), suppliers);
    expect(m).toBeNull();
  });

  it('returns null when vendorName is null', () => {
    const m = matchSupplierFromExtraction(makeExtracted({ vendorName: null }), suppliers);
    expect(m).toBeNull();
  });

  it('includes confidence score in match result', () => {
    const m = matchSupplierFromExtraction(makeExtracted(), suppliers);
    expect(m).not.toBeNull();
    expect(typeof m!.confidence).toBe('number');
    expect(m!.confidence).toBeGreaterThan(0);
  });
});

describe('Invoice Building from Extraction', () => {
  it('maps extracted fields to invoice input', () => {
    const inv = buildInvoiceFromExtraction(makeExtracted(), 'sup-001');
    expect(inv.supplierId).toBe('sup-001');
    expect(inv.invoiceNumber).toBe('MKR-2026-0999');
    expect(inv.invoiceDate).toBe('2026-03-15');
    expect(inv.totalAmount).toBe(10000.00);
  });

  it('maps line items correctly', () => {
    const inv = buildInvoiceFromExtraction(makeExtracted(), 'sup-001');
    expect(inv.items.length).toBe(1);
    expect(inv.items[0]!.description).toBe('Office supplies');
    expect(inv.items[0]!.quantity).toBe(10);
    expect(inv.items[0]!.unitPrice).toBeCloseTo(869.57, 2);
  });

  it('defaults taxRate to 15 when not extracted', () => {
    const inv = buildInvoiceFromExtraction(makeExtracted({ vatRate: null }), 'sup-001');
    expect(inv.taxRate).toBe(15);
  });

  it('uses referenceNumber as invoiceNumber', () => {
    const inv = buildInvoiceFromExtraction(makeExtracted({ referenceNumber: 'INV-999' }), 'sup-001');
    expect(inv.invoiceNumber).toBe('INV-999');
  });
});

describe('Approval Route Determination', () => {
  const thresholds: PipelineThresholds = {
    autoApproveConfidence: 0.95,
    routeApprovalConfidence: 0.85,
    highValueAmount: 100000,
    lowValueAutoApproveAmount: 5000,
  };

  it('routes to auto_approve when confidence >= 0.95', () => {
    expect(determineApprovalRoute(0.97, 10000, thresholds)).toBe('auto_approve');
  });

  it('routes to route_approval when 0.85 <= confidence < 0.95', () => {
    expect(determineApprovalRoute(0.90, 10000, thresholds)).toBe('route_approval');
  });

  it('routes to manual_review when confidence < 0.85', () => {
    expect(determineApprovalRoute(0.70, 10000, thresholds)).toBe('manual_review');
  });

  it('forces manual_review for high-value amounts', () => {
    expect(determineApprovalRoute(0.98, 150000, thresholds)).toBe('manual_review');
  });

  it('auto-approves small amounts with lower confidence', () => {
    expect(determineApprovalRoute(0.88, 2000, thresholds)).toBe('auto_approve');
  });
});

describe('Pipeline Confidence Computation', () => {
  it('returns high confidence when extraction + match both strong', () => {
    const c = computePipelineConfidence(makeExtracted({ confidence: 0.95 }), { supplierId: 'x', supplierName: 'X', confidence: 0.95 });
    expect(c).toBeGreaterThanOrEqual(0.9);
  });

  it('reduces confidence when supplier match is weak', () => {
    const c = computePipelineConfidence(makeExtracted({ confidence: 0.95 }), { supplierId: 'x', supplierName: 'X', confidence: 0.5 });
    expect(c).toBeLessThan(0.9);
  });

  it('reduces confidence when extraction has warnings', () => {
    const c = computePipelineConfidence(makeExtracted({ confidence: 0.95, warnings: ['Low quality scan'] }), { supplierId: 'x', supplierName: 'X', confidence: 0.95 });
    expect(c).toBeLessThan(0.95);
  });

  it('returns 0 when no supplier match', () => {
    const c = computePipelineConfidence(makeExtracted(), null);
    expect(c).toBe(0);
  });
});

// ── buildInvoiceFromExtraction — line item coverage (PRD-05 Phase 2) ─────────

describe('Invoice Building — line items (PRD-05 Phase 2)', () => {
  it('items.length equals extracted.lineItems.length when lineItems non-empty', () => {
    const extracted = makeExtracted({
      lineItems: [
        { description: 'Widget A', quantity: 5, unitPrice: 100, total: 500, vatAmount: null, vatClassification: null, glAccountSuggestion: null },
        { description: 'Widget B', quantity: 2, unitPrice: 250, total: 500, vatAmount: null, vatClassification: null, glAccountSuggestion: null },
        { description: 'Delivery fee', quantity: 1, unitPrice: 50, total: 50, vatAmount: null, vatClassification: null, glAccountSuggestion: null },
      ],
    });

    const inv = buildInvoiceFromExtraction(extracted, 'sup-001');

    expect(inv.items.length).toBe(extracted.lineItems.length);
    expect(inv.items.length).toBe(3);
  });

  it('maps each line item description, quantity, and unitPrice from extraction', () => {
    const extracted = makeExtracted({
      lineItems: [
        { description: 'Laptop stand', quantity: 3, unitPrice: 499.99, total: 1499.97, vatAmount: null, vatClassification: null, glAccountSuggestion: null },
      ],
    });

    const inv = buildInvoiceFromExtraction(extracted, 'sup-001');

    expect(inv.items[0]!.description).toBe('Laptop stand');
    expect(inv.items[0]!.quantity).toBe(3);
    expect(inv.items[0]!.unitPrice).toBeCloseTo(499.99, 2);
  });

  it('with empty lineItems returns exactly one fallback "As per invoice" item', () => {
    const extracted = makeExtracted({ lineItems: [] });

    const inv = buildInvoiceFromExtraction(extracted, 'sup-001');

    expect(inv.items).toHaveLength(1);
    expect(inv.items[0]!.description).toBe('As per invoice');
    expect(inv.items[0]!.quantity).toBe(1);
  });

  it('fallback item unitPrice equals subtotal when provided', () => {
    const extracted = makeExtracted({ lineItems: [], subtotal: 8695.65 });

    const inv = buildInvoiceFromExtraction(extracted, 'sup-001');

    expect(inv.items[0]!.unitPrice).toBeCloseTo(8695.65, 2);
  });

  it('fallback item unitPrice falls back to totalAmount when subtotal is null', () => {
    const extracted = makeExtracted({ lineItems: [], subtotal: null as unknown as number, totalAmount: 10000 });

    const inv = buildInvoiceFromExtraction(extracted, 'sup-001');

    expect(inv.items[0]!.unitPrice).toBeCloseTo(10000, 2);
  });

  it('each item carries the invoice-level taxRate', () => {
    const extracted = makeExtracted({
      vatRate: 15,
      lineItems: [
        { description: 'Item', quantity: 1, unitPrice: 100, total: 100, vatAmount: null, vatClassification: null, glAccountSuggestion: null },
        { description: 'Item 2', quantity: 2, unitPrice: 50, total: 100, vatAmount: null, vatClassification: null, glAccountSuggestion: null },
      ],
    });

    const inv = buildInvoiceFromExtraction(extracted, 'sup-001');

    for (const item of inv.items) {
      expect(item.taxRate).toBe(15);
    }
  });

  it('defaults missing quantity on a line item to 1', () => {
    const extracted = makeExtracted({
      lineItems: [
        { description: 'Bulk item', quantity: null as unknown as number, unitPrice: 200, total: 200, vatAmount: null, vatClassification: null, glAccountSuggestion: null },
      ],
    });

    const inv = buildInvoiceFromExtraction(extracted, 'sup-001');

    expect(inv.items[0]!.quantity).toBe(1);
  });

  it('uses line total as unitPrice when unitPrice is null on a line item', () => {
    const extracted = makeExtracted({
      lineItems: [
        { description: 'Lump sum', quantity: 1, unitPrice: null as unknown as number, total: 750, vatAmount: null, vatClassification: null, glAccountSuggestion: null },
      ],
    });

    const inv = buildInvoiceFromExtraction(extracted, 'sup-001');

    expect(inv.items[0]!.unitPrice).toBeCloseTo(750, 2);
  });
});
