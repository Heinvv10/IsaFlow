/**
 * TDD: Document Extraction Gap Tests
 * Covers: supplier matching, auto-invoice creation, field confidence, Claude vision fallback
 */

import { describe, it, expect } from 'vitest';
import {
  fuzzyMatchSupplier,
  buildAutoInvoiceFromExtraction,
  calculateFieldConfidence,
  buildClaudeVisionPrompt,
  parseClaudeVisionResponse,
  type ExtractedDocFields,
  type SupplierMatch,
  type AutoInvoiceData,
  type FieldConfidence,
} from '@/modules/accounting/services/docExtractionEnhancedService';

// ═══════════════════════════════════════════════════════════════════════════
// SUPPLIER FUZZY MATCHING
// ═══════════════════════════════════════════════════════════════════════════

describe('Supplier Fuzzy Matching', () => {
  const suppliers = [
    { id: 's1', name: 'Woolworths Holdings Ltd' },
    { id: 's2', name: 'MTN Group Limited' },
    { id: 's3', name: 'Vodacom (Pty) Ltd' },
    { id: 's4', name: 'Eskom Holdings SOC Ltd' },
    { id: 's5', name: 'City of Cape Town' },
  ];

  it('matches exact name', () => {
    const result = fuzzyMatchSupplier('Woolworths Holdings Ltd', suppliers);
    expect(result?.supplierId).toBe('s1');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it('matches partial name (strips Pty/Ltd/etc)', () => {
    const result = fuzzyMatchSupplier('Woolworths Holdings', suppliers);
    expect(result?.supplierId).toBe('s1');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it('matches case-insensitive', () => {
    const result = fuzzyMatchSupplier('mtn group limited', suppliers);
    expect(result?.supplierId).toBe('s2');
  });

  it('matches with common abbreviations stripped', () => {
    const result = fuzzyMatchSupplier('Vodacom', suppliers);
    expect(result?.supplierId).toBe('s3');
    expect(result?.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it('returns null for no match', () => {
    const result = fuzzyMatchSupplier('Unknown Company XYZ', suppliers);
    expect(result).toBeNull();
  });

  it('returns null for empty input', () => {
    expect(fuzzyMatchSupplier('', suppliers)).toBeNull();
  });

  it('handles suppliers with special characters', () => {
    const result = fuzzyMatchSupplier('Eskom Holdings', suppliers);
    expect(result?.supplierId).toBe('s4');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AUTO-INVOICE FROM EXTRACTION
// ═══════════════════════════════════════════════════════════════════════════

describe('Auto Invoice from Extraction', () => {
  const sampleExtraction: ExtractedDocFields = {
    vendorName: 'Woolworths',
    documentDate: '2026-03-15',
    referenceNumber: 'INV-2026-001',
    subtotal: 1000,
    vatAmount: 150,
    totalAmount: 1150,
    vatRate: 15,
    lineItems: [
      { description: 'Office supplies', quantity: 10, unitPrice: 100, total: 1000 },
    ],
  };

  it('builds invoice data from extraction', () => {
    const invoice = buildAutoInvoiceFromExtraction(sampleExtraction, 's1');
    expect(invoice.supplierId).toBe('s1');
    expect(invoice.invoiceNumber).toBe('INV-2026-001');
    expect(invoice.totalAmount).toBe(1150);
    expect(invoice.taxAmount).toBe(150);
  });

  it('includes line items', () => {
    const invoice = buildAutoInvoiceFromExtraction(sampleExtraction, 's1');
    expect(invoice.items.length).toBe(1);
    expect(invoice.items[0]!.description).toBe('Office supplies');
    expect(invoice.items[0]!.quantity).toBe(10);
  });

  it('uses extraction date as invoice date', () => {
    const invoice = buildAutoInvoiceFromExtraction(sampleExtraction, 's1');
    expect(invoice.invoiceDate).toBe('2026-03-15');
  });

  it('handles missing line items', () => {
    const invoice = buildAutoInvoiceFromExtraction({ ...sampleExtraction, lineItems: [] }, 's1');
    expect(invoice.items.length).toBe(0);
    expect(invoice.totalAmount).toBe(1150);
  });

  it('handles missing VAT', () => {
    const invoice = buildAutoInvoiceFromExtraction({ ...sampleExtraction, vatAmount: 0 }, 's1');
    expect(invoice.taxAmount).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// PER-FIELD CONFIDENCE
// ═══════════════════════════════════════════════════════════════════════════

describe('Per-Field Confidence', () => {
  it('calculates confidence for each field', () => {
    const result = calculateFieldConfidence({
      vendorName: 'Woolworths Holdings Ltd',
      documentDate: '2026-03-15',
      referenceNumber: 'INV-001',
      totalAmount: 1150,
      vatAmount: 150,
      subtotal: 1000,
      lineItems: [{ description: 'Item', quantity: 1, unitPrice: 1000, total: 1000 }],
    });
    expect(result.vendorName).toBeDefined();
    expect(result.documentDate).toBeDefined();
    expect(result.referenceNumber).toBeDefined();
    expect(result.totalAmount).toBeDefined();
    expect(result.vatAmount).toBeDefined();
  });

  it('high confidence when field present and valid', () => {
    const result = calculateFieldConfidence({
      vendorName: 'Woolworths Holdings Ltd',
      documentDate: '2026-03-15',
      referenceNumber: 'INV-001',
      totalAmount: 1150,
      vatAmount: 150,
      subtotal: 1000,
      lineItems: [],
    });
    expect(result.vendorName).toBeGreaterThanOrEqual(0.8);
    expect(result.totalAmount).toBeGreaterThanOrEqual(0.8);
  });

  it('low confidence when field missing', () => {
    const result = calculateFieldConfidence({
      vendorName: '',
      documentDate: '',
      referenceNumber: '',
      totalAmount: 0,
      vatAmount: 0,
      subtotal: 0,
      lineItems: [],
    });
    expect(result.vendorName).toBeLessThan(0.3);
    expect(result.totalAmount).toBeLessThan(0.3);
  });

  it('validates VAT arithmetic (subtotal + VAT = total)', () => {
    const result = calculateFieldConfidence({
      vendorName: 'Test',
      documentDate: '2026-01-01',
      referenceNumber: 'R1',
      totalAmount: 1150,
      vatAmount: 150,
      subtotal: 1000,
      lineItems: [],
    });
    // 1000 + 150 = 1150 ✓ → high VAT confidence
    expect(result.vatAmount).toBeGreaterThanOrEqual(0.9);
  });

  it('flags VAT arithmetic mismatch', () => {
    const result = calculateFieldConfidence({
      vendorName: 'Test',
      documentDate: '2026-01-01',
      referenceNumber: 'R1',
      totalAmount: 1200,
      vatAmount: 150,
      subtotal: 1000,
      lineItems: [],
    });
    // 1000 + 150 ≠ 1200 → lower confidence
    expect(result.vatAmount).toBeLessThan(0.8);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// CLAUDE VISION FALLBACK
// ═══════════════════════════════════════════════════════════════════════════

describe('Claude Vision Fallback', () => {
  it('builds vision prompt with image context', () => {
    const prompt = buildClaudeVisionPrompt('invoice');
    expect(prompt).toContain('invoice');
    expect(prompt).toContain('JSON');
    expect(prompt).toContain('vendor');
    expect(prompt).toContain('total');
  });

  it('builds different prompts per document type', () => {
    const invoicePrompt = buildClaudeVisionPrompt('invoice');
    const statementPrompt = buildClaudeVisionPrompt('bank_statement');
    expect(invoicePrompt).not.toBe(statementPrompt);
  });

  it('parses valid extraction response', () => {
    const response = '{"vendorName":"Test Co","documentDate":"2026-03-15","totalAmount":1150,"vatAmount":150,"referenceNumber":"INV-001"}';
    const result = parseClaudeVisionResponse(response);
    expect(result).toBeDefined();
    expect(result!.vendorName).toBe('Test Co');
    expect(result!.totalAmount).toBe(1150);
  });

  it('handles JSON in markdown blocks', () => {
    const response = '```json\n{"vendorName":"ABC","totalAmount":500}\n```';
    const result = parseClaudeVisionResponse(response);
    expect(result).toBeDefined();
    expect(result!.vendorName).toBe('ABC');
  });

  it('returns null for invalid response', () => {
    expect(parseClaudeVisionResponse('')).toBeNull();
    expect(parseClaudeVisionResponse('no json here')).toBeNull();
  });
});
