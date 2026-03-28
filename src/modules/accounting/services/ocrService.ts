/**
 * OCR Service — Document data extraction with VLM + regex fallback
 *
 * Primary:  Qwen3 VLM on vLLM (handles images AND text-based PDFs)
 * Fallback: Pattern-based regex extraction for PDFs with text layers
 *
 * Optimised for South African invoices and receipts.
 */

import { log } from '@/lib/logger';
import type { ExtractedDocument, ExtractedLineItem } from '@/modules/accounting/types/documentCapture.types';
import { extractWithVlm, extractPdfWithVlm, isVlmAvailable } from './vlmService';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract structured data from a PDF buffer.
 * Tries VLM first (if configured), then falls back to regex-based extraction.
 */
export async function extractFromPdf(buffer: Buffer): Promise<ExtractedDocument> {
  let rawText = '';
  const warnings: string[] = [];

  // Always attempt text extraction — used by VLM as context and as regex fallback
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    rawText = data.text || '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('PDF text extraction failed', { error: msg }, 'ocr-service');
    warnings.push(`PDF parsing failed: ${msg}`);
  }

  // --- VLM path ---
  if (isVlmAvailable()) {
    try {
      const vlmResult = await extractPdfWithVlm(buffer, rawText);
      if (vlmResult) {
        vlmResult.warnings.push(...warnings);
        return vlmResult;
      }
      warnings.push('VLM extraction returned no result — falling back to regex.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn('VLM extraction failed, falling back to regex', { error: msg }, 'ocr-service');
      warnings.push(`VLM extraction failed: ${msg}`);
    }
  }

  // --- Regex fallback ---
  if (!rawText.trim()) {
    warnings.push('No text found in PDF — the document may be image-based. Manual entry recommended.');
    return emptyResult(rawText, warnings);
  }

  return extractFromText(rawText, warnings);
}

/**
 * Extract structured data from an image buffer (JPEG/PNG).
 * Requires VLM — no regex fallback for images.
 */
export async function extractFromImage(
  imageBuffer: Buffer,
  mimeType: string,
): Promise<ExtractedDocument> {
  const warnings: string[] = [];

  if (!isVlmAvailable()) {
    warnings.push('VLM not configured — cannot extract from images. Set VLLM_BASE_URL in environment.');
    return emptyResult('', warnings);
  }

  try {
    const base64 = imageBuffer.toString('base64');
    const vlmResult = await extractWithVlm(base64, mimeType);
    if (vlmResult) return vlmResult;
    warnings.push('VLM returned no result for image.');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('VLM image extraction failed', { error: msg }, 'ocr-service');
    warnings.push(`VLM image extraction failed: ${msg}`);
  }

  return emptyResult('', warnings);
}

/**
 * Extract structured data from raw text (e.g. pasted or OCR output).
 * Uses VLM if available (sends text as prompt), otherwise regex.
 */
export async function extractFromText(
  rawText: string,
  existingWarnings: string[] = [],
): Promise<ExtractedDocument> {
  const warnings = [...existingWarnings];
  const lines = rawText.split(/\n/).map(l => l.trim()).filter(Boolean);

  if (lines.length === 0) {
    warnings.push('Empty text provided');
    return emptyResult(rawText, warnings);
  }

  // --- Regex extraction ---
  const documentType = detectDocumentType(rawText);
  const vendorName = extractVendorName(lines);
  const vendorVatNumber = extractVatRegistration(rawText);
  const date = extractDate(rawText);
  const referenceNumber = extractReferenceNumber(rawText);
  const amounts = extractAmounts(rawText);
  const lineItems = extractLineItems(lines);

  const confidence = computeConfidence({
    vendorName,
    date,
    referenceNumber,
    totalAmount: amounts.totalAmount,
    vatAmount: amounts.vatAmount,
    lineItems,
  });

  if (confidence < 0.3) {
    warnings.push('Low extraction confidence — please review all fields carefully.');
  }

  return {
    documentType,
    vendorName,
    vendorVatNumber,
    vendorAddress: null,
    vendorBankDetails: null,
    customerName: null,
    customerVatNumber: null,
    date,
    dueDate: null,
    paymentTerms: null,
    referenceNumber,
    purchaseOrderRef: null,
    currency: 'ZAR',
    subtotal: amounts.subtotal,
    vatAmount: amounts.vatAmount,
    vatRate: amounts.vatAmount && amounts.subtotal ? Math.round((amounts.vatAmount / amounts.subtotal) * 100) : null,
    totalAmount: amounts.totalAmount,
    lineItems: lineItems.map(li => ({
      ...li,
      vatAmount: null,
      vatClassification: null,
      glAccountSuggestion: null,
    })),
    rawText,
    confidence,
    warnings,
    extractionMethod: 'regex',
  };
}

// ---------------------------------------------------------------------------
// Document type detection
// ---------------------------------------------------------------------------

function detectDocumentType(text: string): ExtractedDocument['documentType'] {
  const upper = text.toUpperCase();

  if (/CREDIT\s*NOTE/i.test(upper)) return 'credit_note';
  if (/PURCHASE\s*ORDER/i.test(upper)) return 'purchase_order';
  if (/DELIVERY\s*NOTE/i.test(upper)) return 'delivery_note';
  if (/TAX\s*INVOICE/i.test(upper)) return 'invoice';
  if (/INVOICE/i.test(upper)) return 'invoice';
  if (/STATEMENT/i.test(upper)) return 'statement';
  if (/RECEIPT/i.test(upper) || /PROOF\s*OF\s*PAYMENT/i.test(upper)) return 'receipt';

  return 'unknown';
}

// ---------------------------------------------------------------------------
// Vendor name extraction
// ---------------------------------------------------------------------------

function extractVendorName(lines: string[]): string | null {
  const skipPatterns = [
    /^(TAX\s*)?INVOICE$/i,
    /^CREDIT\s*NOTE$/i,
    /^STATEMENT$/i,
    /^RECEIPT$/i,
    /^(page|date|ref|invoice|tel|fax|email|vat|tax|reg)/i,
    /^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/,
    /^P\.?O\.?\s*BOX/i,
    /^\d+\s+(street|road|avenue|drive|lane|crescent)/i,
  ];

  for (let i = 0; i < Math.min(lines.length, 8); i++) {
    const line = lines[i];
    if (!line || line.length < 3 || line.length > 80) continue;
    if (skipPatterns.some(p => p.test(line))) continue;
    if (/^\d+$/.test(line)) continue;
    if (/\b\d{4}\b.*\b(South Africa|SA|RSA)\b/i.test(line)) continue;

    return line;
  }

  const fromMatch = lines.join('\n').match(/(?:From|Supplier|Vendor|Company)\s*[:-]\s*(.+)/i);
  if (fromMatch && fromMatch[1]) return fromMatch[1].trim();

  return null;
}

// ---------------------------------------------------------------------------
// VAT registration number
// ---------------------------------------------------------------------------

function extractVatRegistration(text: string): string | null {
  const patterns = [
    /VAT\s*(?:Reg(?:istration)?\.?\s*)?(?:No\.?|Number|#)\s*[:-]?\s*(\d{10})/i,
    /VAT\s*[:-]?\s*(\d{10})/i,
    /(?:Reg(?:istration)?\.?\s*)?(?:No\.?|Number)\s*[:-]?\s*(\d{10})/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1]) return match[1];
  }

  return null;
}

// ---------------------------------------------------------------------------
// Date extraction
// ---------------------------------------------------------------------------

function extractDate(text: string): string | null {
  const months: Record<string, string> = {
    jan: '01', january: '01',
    feb: '02', february: '02',
    mar: '03', march: '03',
    apr: '04', april: '04',
    may: '05',
    jun: '06', june: '06',
    jul: '07', july: '07',
    aug: '08', august: '08',
    sep: '09', september: '09',
    oct: '10', october: '10',
    nov: '11', november: '11',
    dec: '12', december: '12',
  };

  const labelledPatterns = [
    /(?:Invoice|Document|Tax Invoice|Statement)\s*Date\s*[:-]?\s*(.+)/i,
    /Date\s*[:-]\s*(.+)/i,
    /Dated?\s*[:-]\s*(.+)/i,
  ];

  for (const pattern of labelledPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const parsed = parseDateString(match[1].trim(), months);
      if (parsed) return parsed;
    }
  }

  const slashDate = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (slashDate) {
    const [, d, m, y] = slashDate;
    const day = d!.padStart(2, '0');
    const month = m!.padStart(2, '0');
    if (parseInt(month) >= 1 && parseInt(month) <= 12) {
      return `${y}-${month}-${day}`;
    }
  }

  const isoDate = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDate) {
    return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
  }

  const longDate = text.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (longDate) {
    const day = longDate[1]!.padStart(2, '0');
    const monthNum = months[longDate[2]!.toLowerCase()];
    if (monthNum) return `${longDate[3]}-${monthNum}-${day}`;
  }

  return null;
}

function parseDateString(str: string, months: Record<string, string>): string | null {
  const slashMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slashMatch) {
    const day = slashMatch[1]!.padStart(2, '0');
    const month = slashMatch[2]!.padStart(2, '0');
    if (parseInt(month) >= 1 && parseInt(month) <= 12) {
      return `${slashMatch[3]}-${month}-${day}`;
    }
  }

  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const longMatch = str.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (longMatch) {
    const monthKey = longMatch[2]!.toLowerCase();
    const monthNum = months[monthKey];
    if (monthNum) {
      const day = longMatch[1]!.padStart(2, '0');
      return `${longMatch[3]}-${monthNum}-${day}`;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Reference / invoice number extraction
// ---------------------------------------------------------------------------

function extractReferenceNumber(text: string): string | null {
  const patterns = [
    /Invoice\s*(?:No\.?|Number|#)\s*[:-]?\s*([A-Za-z0-9/-]+)/i,
    /Ref(?:erence)?\s*(?:No\.?|Number|#)\s*[:-]?\s*([A-Za-z0-9/-]+)/i,
    /(?:INV|REF|CN|CR)\s*[-#]?\s*(\d{3,})/i,
    /Document\s*(?:No\.?|Number)\s*[:-]?\s*([A-Za-z0-9/-]+)/i,
    /Order\s*(?:No\.?|Number)\s*[:-]?\s*([A-Za-z0-9/-]+)/i,
    /Receipt\s*(?:No\.?|Number|#)\s*[:-]?\s*([A-Za-z0-9/-]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1] && match[1].length >= 3) {
      return match[1].trim();
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Amount extraction (Total, VAT, Subtotal)
// ---------------------------------------------------------------------------

interface ExtractedAmounts {
  subtotal: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
}

function extractAmounts(text: string): ExtractedAmounts {
  const result: ExtractedAmounts = {
    subtotal: null,
    vatAmount: null,
    totalAmount: null,
  };

  const totalPatterns = [
    /(?:Grand\s*)?Total\s*(?:Due|Amount|Payable)?\s*[:-]?\s*(?:ZAR|R)?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
    /(?:Amount|Balance)\s*(?:Due|Owing|Payable)\s*[:-]?\s*(?:ZAR|R)?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
    /Total\s*(?:Incl(?:uding)?\.?\s*(?:VAT|Tax))?\s*[:-]?\s*(?:ZAR|R)?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
  ];

  for (const pattern of totalPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result.totalAmount = parseAmount(match[1]);
      break;
    }
  }

  const vatPatterns = [
    /VAT\s*(?:@\s*\d+%?)?\s*[:-]?\s*(?:ZAR|R)?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
    /Tax\s*(?:Amount)?\s*[:-]?\s*(?:ZAR|R)?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
    /VAT\s*\(\s*15\s*%\s*\)\s*[:-]?\s*(?:ZAR|R)?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
  ];

  for (const pattern of vatPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result.vatAmount = parseAmount(match[1]);
      break;
    }
  }

  const subtotalPatterns = [
    /Sub\s*[-\s]?Total\s*[:-]?\s*(?:ZAR|R)?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
    /Total\s*(?:Excl(?:uding)?\.?\s*(?:VAT|Tax))\s*[:-]?\s*(?:ZAR|R)?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
    /Nett?\s*(?:Amount|Total)\s*[:-]?\s*(?:ZAR|R)?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/i,
  ];

  for (const pattern of subtotalPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      result.subtotal = parseAmount(match[1]);
      break;
    }
  }

  if (result.totalAmount !== null && result.vatAmount !== null && result.subtotal === null) {
    result.subtotal = Math.round((result.totalAmount - result.vatAmount) * 100) / 100;
  }

  if (result.subtotal !== null && result.vatAmount !== null && result.totalAmount === null) {
    result.totalAmount = Math.round((result.subtotal + result.vatAmount) * 100) / 100;
  }

  return result;
}

function parseAmount(str: string): number {
  const cleaned = str.replace(/[\s,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

// ---------------------------------------------------------------------------
// Line item extraction
// ---------------------------------------------------------------------------

interface RegexLineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
}

function extractLineItems(lines: string[]): RegexLineItem[] {
  const items: RegexLineItem[] = [];

  const lineItemPattern = /^(.+?)\s+(\d+(?:\.\d+)?)\s+(?:R?\s*)?(\d[\d,]*(?:\.\d{2})?)\s+(?:R?\s*)?(\d[\d,]*(?:\.\d{2})?)$/;
  const simpleLinePattern = /^(.{3,}?)\s{2,}(?:R?\s*)?(\d[\d,]*(?:\.\d{2})?)$/;

  let itemsStarted = false;
  const headerPattern = /(?:description|item|product|service)\s.*(?:qty|quantity|amount|price|total)/i;

  for (const line of lines) {
    if (headerPattern.test(line)) {
      itemsStarted = true;
      continue;
    }

    if (!itemsStarted && items.length === 0) {
      const match = lineItemPattern.exec(line);
      if (match) itemsStarted = true;
    }

    if (!itemsStarted) continue;

    if (/^(Sub\s*[-\s]?Total|Total|VAT|Tax|Amount\s*Due|Balance\s*Due|Grand\s*Total)/i.test(line)) {
      break;
    }

    const fullMatch = lineItemPattern.exec(line);
    if (fullMatch) {
      items.push({
        description: fullMatch[1]!.trim(),
        quantity: parseFloat(fullMatch[2]!),
        unitPrice: parseAmount(fullMatch[3]!),
        total: parseAmount(fullMatch[4]!),
      });
      continue;
    }

    const simpleMatch = simpleLinePattern.exec(line);
    if (simpleMatch) {
      items.push({
        description: simpleMatch[1]!.trim(),
        quantity: null,
        unitPrice: null,
        total: parseAmount(simpleMatch[2]!),
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Confidence scoring
// ---------------------------------------------------------------------------

function computeConfidence(fields: {
  vendorName: string | null;
  date: string | null;
  referenceNumber: string | null;
  totalAmount: number | null;
  vatAmount: number | null;
  lineItems: RegexLineItem[];
}): number {
  let score = 0;
  const weights = {
    vendorName: 0.2,
    date: 0.2,
    referenceNumber: 0.15,
    totalAmount: 0.25,
    vatAmount: 0.1,
    lineItems: 0.1,
  };

  if (fields.vendorName) score += weights.vendorName;
  if (fields.date) score += weights.date;
  if (fields.referenceNumber) score += weights.referenceNumber;
  if (fields.totalAmount !== null && fields.totalAmount > 0) score += weights.totalAmount;
  if (fields.vatAmount !== null && fields.vatAmount > 0) score += weights.vatAmount;
  if (fields.lineItems.length > 0) score += weights.lineItems;

  return Math.round(score * 100) / 100;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyResult(rawText: string, warnings: string[]): ExtractedDocument {
  return {
    documentType: 'unknown',
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
    rawText,
    confidence: 0,
    warnings,
    extractionMethod: 'regex',
  };
}
