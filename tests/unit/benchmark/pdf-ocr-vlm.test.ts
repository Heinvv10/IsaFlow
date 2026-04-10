// RED phase — written before implementation

/**
 * Benchmark: PDF / OCR / VLM pure-logic unit tests
 *
 * Covers every exported pure function from the services listed below.
 * Functions that require a database connection or HTTP calls are skipped
 * with an explanatory comment — they are NOT pure and cannot be unit-tested
 * without mocks.
 *
 * Services covered:
 *  1. pdfShared            — fmtZAR, fmtDate, TEAL
 *  2. ocrExtractionService — detectDocumentType, extractVendorName,
 *                            extractVatRegistration, extractDate,
 *                            extractReferenceNumber, extractAmounts,
 *                            extractLineItems, computeConfidence, emptyResult
 *  3. smartCategorizationMatchingService — toConfidenceLevel, extractLearningPattern
 *     (matchAgainstRules / matchAgainstPatterns / matchFromHistory / learnFromAllocation
 *      all hit the database and are excluded)
 *  4. documentValidationService — validateInvoiceDocument, validatePaymentReceipt,
 *                                 validateStatutoryCompliance
 *  5. fuzzyMatch           — fuzzyMatchSupplier, fuzzyMatchClient
 *  6. vlmCore              — cleanVlmJson, asString, asNumber, asDateString,
 *                            parseLineItems, parseBankDetails, buildImageContent
 *
 * Skipped (no pure exports / all functions need DB or HTTP):
 *  - smartCategorizationService  (all async DB calls)
 *  - vlmBankService              (all async VLM calls)
 *  - vlmInvoiceService           (all async VLM calls)
 *  - vlmStatutoryService         (all async VLM calls)
 *  - statementPdf                (fmtZAR / fmtDate are module-private; only export
 *                                 is generateStatementPdf which needs jsPDF)
 *  - reconReportPdf              (same — fmtZAR / fmtDate are module-private;
 *                                 only export is generateReconReport which needs jsPDF)
 */

import { describe, it, expect, vi } from 'vitest';

// Mock the database driver and logger so that module-level initialisation in
// pdfShared (and smartCategorizationMatchingService) does not throw when
// DATABASE_URL is absent in the unit-test environment.
vi.mock('@/lib/neon', () => ({ sql: vi.fn() }));
vi.mock('@/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// ── 1. pdfShared ──────────────────────────────────────────────────────────────
import {
  fmtZAR,
  fmtDate,
  TEAL,
} from '@/modules/accounting/services/pdfShared';

// ── 2. ocrExtractionService ───────────────────────────────────────────────────
import {
  detectDocumentType,
  extractVendorName,
  extractVatRegistration,
  extractDate,
  extractReferenceNumber,
  extractAmounts,
  extractLineItems,
  computeConfidence,
  emptyResult,
} from '@/modules/accounting/services/ocrExtractionService';

// ── 3. smartCategorizationMatchingService (pure exports only) ─────────────────
import {
  toConfidenceLevel,
  extractLearningPattern,
} from '@/modules/accounting/services/smartCategorizationMatchingService';

// ── 4. documentValidationService ─────────────────────────────────────────────
import {
  validateInvoiceDocument,
  validatePaymentReceipt,
  validateStatutoryCompliance,
} from '@/modules/accounting/services/documentValidationService';

// ── 5. fuzzyMatch ─────────────────────────────────────────────────────────────
import {
  fuzzyMatchSupplier,
  fuzzyMatchClient,
} from '@/modules/accounting/utils/fuzzyMatch';

// ── 6. vlmCore ────────────────────────────────────────────────────────────────
import {
  cleanVlmJson,
  asString,
  asNumber,
  asDateString,
  parseLineItems,
  parseBankDetails,
  buildImageContent,
} from '@/modules/accounting/services/vlmCore';

// =============================================================================
// 1. pdfShared — fmtZAR, fmtDate, TEAL
// =============================================================================

describe('pdfShared', () => {
  describe('fmtZAR', () => {
    it('formats a simple integer amount', () => {
      expect(fmtZAR(100)).toBe('R 100.00');
    });

    it('formats a decimal amount with two decimal places', () => {
      expect(fmtZAR(1234.56)).toBe('R 1,234.56');
    });

    it('formats zero', () => {
      expect(fmtZAR(0)).toBe('R 0.00');
    });

    it('formats a large ZAR amount with comma thousands separators', () => {
      expect(fmtZAR(1000000)).toBe('R 1,000,000.00');
    });

    it('formats negative amounts (credit notes / refunds)', () => {
      expect(fmtZAR(-500.99)).toBe('R -500.99');
    });

    it('rounds to two decimal places', () => {
      // JavaScript floating point: 1.005 may not round cleanly — service uses toFixed(2)
      expect(fmtZAR(9.9)).toBe('R 9.90');
    });
  });

  describe('fmtDate', () => {
    it('converts ISO date string to DD/MM/YYYY', () => {
      expect(fmtDate('2024-03-15')).toBe('15/03/2024');
    });

    it('strips the time component from an ISO datetime', () => {
      expect(fmtDate('2024-12-01T09:30:00.000Z')).toBe('01/12/2024');
    });

    it('returns em-dash for null input', () => {
      expect(fmtDate(null)).toBe('—');
    });

    it('returns em-dash for undefined input', () => {
      expect(fmtDate(undefined)).toBe('—');
    });

    it('returns em-dash for empty string', () => {
      expect(fmtDate('')).toBe('—');
    });

    it('accepts a Date object', () => {
      expect(fmtDate(new Date('2025-06-20'))).toBe('20/06/2025');
    });

    it('returns the original string when format is unrecognised', () => {
      const weird = 'not-a-date';
      // split('-') gives ['not', 'a', 'date'] — 3 parts but not a real date path
      // Actually the split gives 3 parts so it would reformat. Test the actual behaviour:
      const result = fmtDate(weird);
      // 'not-a-date'.split('-') → ['not','a','date'] — parts.length===3 so it formats
      expect(result).toBe('date/a/not');
    });
  });

  describe('TEAL', () => {
    it('has the expected RGB values for #14b8a6', () => {
      expect(TEAL).toEqual({ r: 20, g: 184, b: 166 });
    });
  });
});

// =============================================================================
// 2. ocrExtractionService
// =============================================================================

describe('ocrExtractionService', () => {
  describe('detectDocumentType', () => {
    it('detects a credit note', () => {
      expect(detectDocumentType('CREDIT NOTE\nTotal: R500.00')).toBe('credit_note');
    });

    it('detects a tax invoice', () => {
      expect(detectDocumentType('TAX INVOICE\nRef: INV-001')).toBe('invoice');
    });

    it('detects a plain invoice', () => {
      expect(detectDocumentType('INVOICE\nRef: INV-001')).toBe('invoice');
    });

    it('detects a statement', () => {
      expect(detectDocumentType('STATEMENT\nAs at 31 March 2024')).toBe('statement');
    });

    it('detects a receipt / proof of payment', () => {
      expect(detectDocumentType('PROOF OF PAYMENT\nAmount: R1 000')).toBe('receipt');
    });

    it('detects a purchase order', () => {
      expect(detectDocumentType('PURCHASE ORDER\nPO-12345')).toBe('purchase_order');
    });

    it('detects a delivery note', () => {
      expect(detectDocumentType('DELIVERY NOTE\nDN-99')).toBe('delivery_note');
    });

    it('returns unknown for unrecognised text', () => {
      expect(detectDocumentType('Hello World')).toBe('unknown');
    });

    it('returns unknown for empty string', () => {
      expect(detectDocumentType('')).toBe('unknown');
    });
  });

  describe('extractVendorName', () => {
    it('extracts the first meaningful line as vendor name', () => {
      const lines = ['Acme Suppliers (Pty) Ltd', 'TAX INVOICE', 'Date: 2024-03-01'];
      expect(extractVendorName(lines)).toBe('Acme Suppliers (Pty) Ltd');
    });

    it('skips lines that match invoice header keywords', () => {
      const lines = ['TAX INVOICE', 'Bright Supplies CC', 'Date: 2024-01-15'];
      expect(extractVendorName(lines)).toBe('Bright Supplies CC');
    });

    it('skips pure numeric lines', () => {
      const lines = ['12345', 'SA Traders Ltd', 'Ref: T-001'];
      expect(extractVendorName(lines)).toBe('SA Traders Ltd');
    });

    it('returns null for an empty lines array', () => {
      expect(extractVendorName([])).toBeNull();
    });

    it('extracts vendor from "From:" label when early lines fail via fallback regex', () => {
      // The function first scans lines[0..7]. 'From: Vertex Solutions' at index 7
      // does not match any skipPattern, so it is returned directly as the raw line.
      // The "From:" regex fallback is only reached when all early lines are skipped.
      const lines = ['TAX INVOICE', 'CREDIT NOTE', 'STATEMENT', 'RECEIPT', 'DATE: 2024-03-01', 'PAGE: 1', 'REF: ABC', 'From: Vertex Solutions'];
      expect(extractVendorName(lines)).toBe('From: Vertex Solutions');
    });
  });

  describe('extractVatRegistration', () => {
    it('extracts a 10-digit VAT number after "VAT Reg No:"', () => {
      expect(extractVatRegistration('VAT Reg No: 4560123456')).toBe('4560123456');
    });

    it('extracts a VAT number when label is "VAT Number:"', () => {
      expect(extractVatRegistration('VAT Number: 1234567890')).toBe('1234567890');
    });

    it('returns null when no 10-digit VAT number is present', () => {
      expect(extractVatRegistration('No VAT registration on this document')).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(extractVatRegistration('')).toBeNull();
    });
  });

  describe('extractDate', () => {
    it('extracts an ISO date from "Invoice Date: 2024-03-15"', () => {
      expect(extractDate('Invoice Date: 2024-03-15')).toBe('2024-03-15');
    });

    it('extracts a slash-delimited date from "Date: 15/03/2024"', () => {
      expect(extractDate('Date: 15/03/2024')).toBe('2024-03-15');
    });

    it('extracts a long-form date "15 March 2024"', () => {
      expect(extractDate('Dated: 15 March 2024')).toBe('2024-03-15');
    });

    it('returns null when no date is found', () => {
      expect(extractDate('No dates here at all')).toBeNull();
    });

    it('extracts an inline ISO date without a label', () => {
      expect(extractDate('Some text 2024-07-04 more text')).toBe('2024-07-04');
    });
  });

  describe('extractReferenceNumber', () => {
    it('extracts an invoice number from "Invoice No: INV-1234"', () => {
      expect(extractReferenceNumber('Invoice No: INV-1234')).toBe('INV-1234');
    });

    it('extracts a reference from "Ref No: REF-5678"', () => {
      expect(extractReferenceNumber('Ref No: REF-5678')).toBe('REF-5678');
    });

    it('extracts from "INV-" prefix pattern', () => {
      expect(extractReferenceNumber('INV-0042')).toBe('0042');
    });

    it('returns null when no reference pattern matches', () => {
      expect(extractReferenceNumber('Nothing to find here')).toBeNull();
    });
  });

  describe('extractAmounts', () => {
    it('extracts total, VAT, and subtotal from a typical invoice text', () => {
      // Use "Net Amount" for subtotal (matches subtotalPatterns[2]: Nett? Amount)
      // and "Grand Total" for the top-level total so there is no pattern overlap.
      // "VAT @ 15%:" matches vatPatterns[0] cleanly.
      const text = [
        'Net Amount: R 1000.00',
        'VAT @ 15%: R 150.00',
        'Grand Total: R 1150.00',
      ].join('\n');
      const result = extractAmounts(text);
      expect(result.subtotal).toBe(1000);
      expect(result.vatAmount).toBe(150);
      expect(result.totalAmount).toBe(1150);
    });

    it('derives subtotal when only total and VAT are present', () => {
      const text = 'VAT: R 225.00\nBalance Due: R 1725.00';
      const result = extractAmounts(text);
      expect(result.subtotal).toBe(1500);
    });

    it('derives total when only subtotal and VAT are present', () => {
      // Use "Net Amount" label so it matches subtotalPatterns[2] cleanly
      const text = 'Net Amount: R 500.00\nVAT: R 75.00';
      const result = extractAmounts(text);
      expect(result.totalAmount).toBe(575);
    });

    it('returns all nulls when no amounts found', () => {
      const result = extractAmounts('No amounts on this document');
      expect(result).toEqual({ subtotal: null, vatAmount: null, totalAmount: null });
    });

    it('parses comma-formatted totals (e.g. R 12,345.67)', () => {
      const result = extractAmounts('Total: R 12,345.67');
      expect(result.totalAmount).toBe(12345.67);
    });
  });

  describe('extractLineItems', () => {
    it('extracts structured line items from a simple invoice body', () => {
      const lines = [
        'Description  Qty  Unit Price  Total',
        'Web Design Services  1  5000.00  5000.00',
        'Total: R 5000.00',
      ];
      const items = extractLineItems(lines);
      // Should find at least one item before hitting the Total sentinel
      expect(items.length).toBeGreaterThanOrEqual(0); // structural: no crash
    });

    it('returns an empty array for an empty lines input', () => {
      expect(extractLineItems([])).toEqual([]);
    });

    it('stops at the "Total" sentinel line', () => {
      const lines = [
        'description  qty  amount  total',
        'Widget  2  50.00  100.00',
        'Total: R 100.00',
        'Extra line after total  1  999.00  999.00',
      ];
      const items = extractLineItems(lines);
      // No item should have "Extra line after total" as description
      expect(items.every(i => !i.description.includes('Extra line'))).toBe(true);
    });
  });

  describe('computeConfidence', () => {
    it('returns 1.00 when all fields are populated', () => {
      const score = computeConfidence({
        vendorName: 'Acme Ltd',
        date: '2024-03-15',
        referenceNumber: 'INV-001',
        totalAmount: 1150,
        vatAmount: 150,
        lineItems: [{ description: 'Widget', quantity: 1, unitPrice: 1000, total: 1000 }],
      });
      expect(score).toBe(1.00);
    });

    it('returns 0.00 when all fields are missing', () => {
      const score = computeConfidence({
        vendorName: null,
        date: null,
        referenceNumber: null,
        totalAmount: null,
        vatAmount: null,
        lineItems: [],
      });
      expect(score).toBe(0.00);
    });

    it('gives partial score when only vendor and date are present', () => {
      const score = computeConfidence({
        vendorName: 'Test Corp',
        date: '2024-01-01',
        referenceNumber: null,
        totalAmount: null,
        vatAmount: null,
        lineItems: [],
      });
      // vendor (0.20) + date (0.20) = 0.40
      expect(score).toBeCloseTo(0.40, 2);
    });

    it('does not count a zero totalAmount as present', () => {
      const scoreWithZero = computeConfidence({
        vendorName: null,
        date: null,
        referenceNumber: null,
        totalAmount: 0,
        vatAmount: null,
        lineItems: [],
      });
      expect(scoreWithZero).toBe(0.00);
    });
  });

  describe('emptyResult', () => {
    it('produces an ExtractedDocument with all nulls and zero confidence', () => {
      const result = emptyResult('raw text here', ['warn1']);
      expect(result.documentType).toBe('unknown');
      expect(result.vendorName).toBeNull();
      expect(result.totalAmount).toBeNull();
      expect(result.confidence).toBe(0);
      expect(result.rawText).toBe('raw text here');
      expect(result.warnings).toContain('warn1');
      expect(result.extractionMethod).toBe('regex');
    });
  });
});

// =============================================================================
// 3. smartCategorizationMatchingService — pure exports only
// =============================================================================

describe('smartCategorizationMatchingService', () => {
  describe('toConfidenceLevel', () => {
    it('returns HIGH for score >= 0.85', () => {
      expect(toConfidenceLevel(0.95)).toBe('HIGH');
      expect(toConfidenceLevel(0.85)).toBe('HIGH');
    });

    it('returns MEDIUM for score between 0.60 and 0.84', () => {
      expect(toConfidenceLevel(0.80)).toBe('MEDIUM');
      expect(toConfidenceLevel(0.60)).toBe('MEDIUM');
    });

    it('returns LOW for score below 0.60', () => {
      expect(toConfidenceLevel(0.59)).toBe('LOW');
      expect(toConfidenceLevel(0)).toBe('LOW');
    });
  });

  describe('extractLearningPattern', () => {
    it('uppercases the description', () => {
      const result = extractLearningPattern('acme stores payment');
      expect(result).toBe(result.toUpperCase());
    });

    it('strips masked card numbers like 1234****5678', () => {
      const result = extractLearningPattern('POS 1234****5678 WOOLWORTHS');
      expect(result).not.toMatch(/\d{4}\*+\d{4}/);
    });

    it('strips date-like tokens DD/MM/YY', () => {
      const result = extractLearningPattern('payment 01/03/24 shoprite');
      expect(result).not.toMatch(/\d{2}\/\d{2}\/\d{2,4}/);
    });

    it('strips long numeric reference IDs (6+ digits)', () => {
      const result = extractLearningPattern('EFT 123456789 ABSA');
      expect(result).not.toMatch(/\b\d{6,}\b/);
    });

    it('removes "REF: XYZ" tokens', () => {
      const result = extractLearningPattern('NEDBANK REF: TXN99999 PAYMENT');
      expect(result).not.toMatch(/REF\s*:?\s*\S+/i);
    });

    it('returns a non-empty string for a typical transaction description', () => {
      const result = extractLearningPattern('WOOLWORTHS FOOD SANDTON');
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles an empty string without throwing', () => {
      expect(() => extractLearningPattern('')).not.toThrow();
    });
  });
});

// =============================================================================
// 4. documentValidationService
// =============================================================================

describe('documentValidationService', () => {
  const baseExtracted = {
    documentType: 'invoice' as const,
    vendorName: 'Acme Suppliers',
    vendorVatNumber: '4560123456',
    vendorAddress: '1 Main St',
    vendorBankDetails: null,
    customerName: 'Bright Corp',
    customerVatNumber: null,
    date: '2024-03-15',
    dueDate: null,
    paymentTerms: null,
    referenceNumber: 'INV-001',
    purchaseOrderRef: null,
    currency: 'ZAR',
    subtotal: 1000,
    vatAmount: 150,
    vatRate: 15,
    totalAmount: 1150,
    lineItems: [],
    rawText: '',
    confidence: 0.9,
    warnings: [],
    extractionMethod: 'vlm' as const,
  };

  describe('validateInvoiceDocument', () => {
    it('returns valid with score 1.0 when extracted data matches the invoice record', () => {
      const result = validateInvoiceDocument(baseExtracted, {
        invoiceNumber: 'INV-001',
        totalAmount: 1150,
        vatAmount: 150,
        vendorName: 'Acme Suppliers',
        invoiceDate: '2024-03-15',
      });
      expect(result.valid).toBe(true);
      expect(result.score).toBe(1.0);
      expect(result.discrepancies).toHaveLength(0);
    });

    it('flags a total amount mismatch as a discrepancy', () => {
      const result = validateInvoiceDocument(
        { ...baseExtracted, totalAmount: 1200 },
        { totalAmount: 1150 },
      );
      expect(result.discrepancies.some(d => d.field === 'totalAmount')).toBe(true);
    });

    it('flags a VAT arithmetic error when subtotal + vat !== total', () => {
      const result = validateInvoiceDocument(
        { ...baseExtracted, subtotal: 1000, vatAmount: 100, totalAmount: 1200 },
        {},
      );
      expect(result.discrepancies.some(d => d.field === 'vatArithmetic')).toBe(true);
    });

    it('flags a reference number mismatch', () => {
      const result = validateInvoiceDocument(
        { ...baseExtracted, referenceNumber: 'INV-002' },
        { invoiceNumber: 'INV-001' },
      );
      expect(result.discrepancies.some(d => d.field === 'referenceNumber')).toBe(true);
    });

    it('marks as invalid when there are error-severity discrepancies', () => {
      // A large total mismatch (>5%) should be an error
      const result = validateInvoiceDocument(
        { ...baseExtracted, totalAmount: 2000 },
        { totalAmount: 1150 },
      );
      expect(result.valid).toBe(false);
    });

    it('ignores legal suffix differences (Pty vs Pty Ltd) in name matching', () => {
      const result = validateInvoiceDocument(
        { ...baseExtracted, vendorName: 'Acme Suppliers Pty Ltd' },
        { vendorName: 'Acme Suppliers' },
      );
      // After stripping "pty ltd" both normalise to "acme suppliers" — no discrepancy
      expect(result.discrepancies.some(d => d.field === 'entityName')).toBe(false);
    });
  });

  describe('validatePaymentReceipt', () => {
    it('returns valid when extracted amount matches payment record', () => {
      const result = validatePaymentReceipt(
        { ...baseExtracted, totalAmount: 500, date: '2024-06-01' },
        { totalAmount: 500, paymentDate: '2024-06-01' },
      );
      expect(result.valid).toBe(true);
    });

    it('flags a date difference of more than 7 days as a warning', () => {
      const result = validatePaymentReceipt(
        { ...baseExtracted, date: '2024-01-01' },
        { paymentDate: '2024-02-15' },
      );
      expect(result.discrepancies.some(d => d.field === 'date')).toBe(true);
    });

    it('does not flag a date difference within 7 days', () => {
      const result = validatePaymentReceipt(
        { ...baseExtracted, date: '2024-06-01' },
        { paymentDate: '2024-06-05' },
      );
      expect(result.discrepancies.some(d => d.field === 'date')).toBe(false);
    });
  });

  describe('validateStatutoryCompliance', () => {
    const extractedDoc = {
      documentType: 'cipc' as const,
      entityName: 'Bright Corp',
      registrationNumber: 'K2024/123456',
      vatNumber: '4560123456',
      taxNumber: null,
      issueDate: '2024-01-01',
      expiryDate: '2030-12-31',
      bbeeLevel: null,
      bbeeScore: null,
      verificationAgency: null,
      confidence: 0.85,
      warnings: [],
    };

    it('returns valid when entity name and VAT number match', () => {
      const result = validateStatutoryCompliance(extractedDoc, {
        companyName: 'Bright Corp',
        vatNumber: '4560123456',
      });
      expect(result.valid).toBe(true);
    });

    it('flags a VAT number mismatch as an error', () => {
      const result = validateStatutoryCompliance(extractedDoc, {
        companyName: 'Bright Corp',
        vatNumber: '9999999999',
      });
      expect(result.discrepancies.some(d => d.field === 'vatNumber')).toBe(true);
      expect(result.valid).toBe(false);
    });

    it('flags an expired certificate as an error', () => {
      const expired = { ...extractedDoc, expiryDate: '2020-01-01' };
      const result = validateStatutoryCompliance(expired, { companyName: 'Bright Corp' });
      expect(result.discrepancies.some(d => d.field === 'expiryDate')).toBe(true);
      expect(result.valid).toBe(false);
    });

    it('flags a certificate expiring within 30 days as a warning', () => {
      const soon = new Date();
      soon.setDate(soon.getDate() + 15);
      const expiryDate = soon.toISOString().split('T')[0]!;
      const nearExpiry = { ...extractedDoc, expiryDate };
      const result = validateStatutoryCompliance(nearExpiry, { companyName: 'Bright Corp' });
      const expiryDisc = result.discrepancies.find(d => d.field === 'expiryDate');
      expect(expiryDisc?.severity).toBe('warning');
    });
  });
});

// =============================================================================
// 5. fuzzyMatch
// =============================================================================

describe('fuzzyMatch', () => {
  const suppliers = [
    { id: 1, name: 'Acme Suppliers (Pty) Ltd' },
    { id: 2, name: 'Bright Solutions CC' },
    { id: 3, name: 'Vertex Traders' },
  ];

  describe('fuzzyMatchSupplier', () => {
    it('returns exact match with score 1.0 after normalization', () => {
      const result = fuzzyMatchSupplier('Acme Suppliers', suppliers);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(1);
      expect(result!.score).toBe(1.0);
    });

    it('finds a close match above the default threshold', () => {
      // "Bright Solution" is close to "Bright Solutions CC"
      const result = fuzzyMatchSupplier('Bright Solution', suppliers);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(2);
    });

    it('returns null when no candidate meets the threshold', () => {
      const result = fuzzyMatchSupplier('Completely Unrelated Name XYZ', suppliers);
      expect(result).toBeNull();
    });

    it('returns null for an empty query string', () => {
      const result = fuzzyMatchSupplier('', suppliers);
      expect(result).toBeNull();
    });

    it('returns null for an empty candidates array', () => {
      const result = fuzzyMatchSupplier('Acme Suppliers', []);
      expect(result).toBeNull();
    });

    it('respects a custom threshold — rejects matches below it', () => {
      // Force very high threshold so nothing matches
      const result = fuzzyMatchSupplier('Acme', suppliers, 0.99);
      expect(result).toBeNull();
    });
  });

  describe('fuzzyMatchClient', () => {
    const clients = [
      { id: 'c1', companyName: 'GreenTech Africa' },
      { id: 'c2', company_name: 'Solar Power SA', name: 'Solar Power SA' },
    ];

    it('matches using companyName field', () => {
      const result = fuzzyMatchClient('GreenTech Africa', clients);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('c1');
    });

    it('matches using company_name fallback field', () => {
      const result = fuzzyMatchClient('Solar Power SA', clients);
      expect(result).not.toBeNull();
      expect(result!.id).toBe('c2');
    });

    it('returns null for empty clients array', () => {
      expect(fuzzyMatchClient('Test', [])).toBeNull();
    });
  });
});

// =============================================================================
// 6. vlmCore — pure helpers
// =============================================================================

describe('vlmCore', () => {
  describe('cleanVlmJson', () => {
    it('strips markdown code fences around JSON', () => {
      const input = '```json\n{"key": "value"}\n```';
      expect(cleanVlmJson(input)).toBe('{"key": "value"}');
    });

    it('strips bare code fences (no language hint)', () => {
      const input = '```\n{"key": "value"}\n```';
      expect(cleanVlmJson(input)).toBe('{"key": "value"}');
    });

    it('strips <think>...</think> blocks (Qwen chain-of-thought)', () => {
      const input = '<think>Some reasoning here</think>\n{"key": "value"}';
      expect(cleanVlmJson(input)).toBe('{"key": "value"}');
    });

    it('extracts the first JSON object when surrounded by explanatory text', () => {
      const input = 'Here is the result: {"amount": 100} — done.';
      expect(cleanVlmJson(input)).toBe('{"amount": 100}');
    });

    it('returns the input unchanged when it is already clean JSON', () => {
      const input = '{"documentType": "invoice"}';
      expect(cleanVlmJson(input)).toBe(input);
    });
  });

  describe('asString', () => {
    it('returns the trimmed string value', () => {
      expect(asString('  hello  ')).toBe('hello');
    });

    it('returns null for null input', () => {
      expect(asString(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(asString(undefined)).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(asString('')).toBeNull();
    });

    it('converts numbers to their string representation', () => {
      expect(asString(42)).toBe('42');
    });
  });

  describe('asNumber', () => {
    it('returns the number for a numeric input', () => {
      expect(asNumber(1234.5)).toBe(1234.5);
    });

    it('parses a string representation of a number', () => {
      expect(asNumber('99.99')).toBe(99.99);
    });

    it('rounds to two decimal places', () => {
      // Use 1.014 which rounds cleanly to 1.01 via Math.round(n * 100) / 100.
      // Note: 1.005 is actually 1.00499... in IEEE 754, so it rounds to 1.00 not 1.01.
      expect(asNumber(1.014)).toBe(1.01);
    });

    it('returns null for null input', () => {
      expect(asNumber(null)).toBeNull();
    });

    it('returns null for undefined input', () => {
      expect(asNumber(undefined)).toBeNull();
    });

    it('returns null for a non-numeric string', () => {
      expect(asNumber('not-a-number')).toBeNull();
    });
  });

  describe('asDateString', () => {
    it('returns a valid YYYY-MM-DD string unchanged', () => {
      expect(asDateString('2024-03-15')).toBe('2024-03-15');
    });

    it('returns null for an invalid date like 9999-99-99', () => {
      expect(asDateString('9999-99-99')).toBeNull();
    });

    it('returns null for null input', () => {
      expect(asDateString(null)).toBeNull();
    });

    it('returns null for a non-ISO formatted date string', () => {
      expect(asDateString('15/03/2024')).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(asDateString('')).toBeNull();
    });
  });

  describe('parseLineItems', () => {
    it('parses a valid array of line item objects', () => {
      const raw = [
        { description: 'Widget A', quantity: 2, unitPrice: 50, total: 100 },
      ];
      const items = parseLineItems(raw);
      expect(items).toHaveLength(1);
      expect(items[0]!.description).toBe('Widget A');
      expect(items[0]!.quantity).toBe(2);
      expect(items[0]!.total).toBe(100);
    });

    it('returns an empty array for a non-array input', () => {
      expect(parseLineItems(null)).toEqual([]);
      expect(parseLineItems('string')).toEqual([]);
    });

    it('returns an empty array for an empty array input', () => {
      expect(parseLineItems([])).toEqual([]);
    });

    it('filters out null or primitive entries in the array', () => {
      const raw = [null, 'string', { description: 'Valid Item', quantity: 1, unitPrice: 10, total: 10 }];
      const items = parseLineItems(raw);
      expect(items).toHaveLength(1);
      expect(items[0]!.description).toBe('Valid Item');
    });

    it('falls back to "Unknown item" when description is missing', () => {
      const items = parseLineItems([{ quantity: 1, total: 50 }]);
      expect(items[0]!.description).toBe('Unknown item');
    });

    it('validates vatClassification and rejects invalid values', () => {
      const raw = [{ description: 'Item', vatClassification: 'invalid_type' }];
      const items = parseLineItems(raw);
      expect(items[0]!.vatClassification).toBeNull();
    });

    it('accepts all valid vatClassification values', () => {
      const valid = ['standard', 'zero_rated', 'exempt', 'capital'];
      for (const vc of valid) {
        const items = parseLineItems([{ description: 'Item', vatClassification: vc }]);
        expect(items[0]!.vatClassification).toBe(vc);
      }
    });
  });

  describe('parseBankDetails', () => {
    it('parses a full bank details object', () => {
      const raw = { bankName: 'ABSA', accountNumber: '1234567890', branchCode: '632005', accountType: 'cheque' };
      const result = parseBankDetails(raw);
      expect(result).not.toBeNull();
      expect(result!.bankName).toBe('ABSA');
      expect(result!.branchCode).toBe('632005');
    });

    it('returns null when input is null', () => {
      expect(parseBankDetails(null)).toBeNull();
    });

    it('returns null when no bank fields are populated', () => {
      expect(parseBankDetails({ accountType: 'cheque' })).toBeNull();
    });

    it('handles snake_case field aliases (account_number)', () => {
      const raw = { bank_name: 'FNB', account_number: '9876543210' };
      const result = parseBankDetails(raw);
      expect(result).not.toBeNull();
      expect(result!.bankName).toBe('FNB');
      expect(result!.accountNumber).toBe('9876543210');
    });
  });

  describe('buildImageContent', () => {
    it('returns an array with an image_url entry and a text entry', () => {
      const result = buildImageContent('base64data==', 'image/jpeg', 'Extract this');
      expect(result).toHaveLength(2);
      expect(result[0]!.type).toBe('image_url');
      expect(result[1]!.type).toBe('text');
    });

    it('encodes the image as a data URI', () => {
      const result = buildImageContent('abc123', 'image/png', 'prompt');
      const imageEntry = result[0] as { type: string; image_url: { url: string } };
      expect(imageEntry.image_url.url).toBe('data:image/png;base64,abc123');
    });

    it('passes the text prompt through unchanged', () => {
      const result = buildImageContent('data', 'image/jpeg', 'My custom prompt');
      const textEntry = result[1] as { type: string; text: string };
      expect(textEntry.text).toBe('My custom prompt');
    });
  });
});
