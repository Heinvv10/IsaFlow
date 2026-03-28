/**
 * OCR Service — Pattern-based document data extraction
 * Extracts vendor, date, amounts, VAT, reference numbers from PDF text.
 * Optimised for South African invoices and receipts.
 */

import { log } from '@/lib/logger';
import type { ExtractedDocument, ExtractedLineItem } from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract structured data from a PDF buffer.
 * Uses pdf-parse to get the text layer, then runs pattern extraction.
 */
export async function extractFromPdf(buffer: Buffer): Promise<ExtractedDocument> {
  let rawText = '';
  const warnings: string[] = [];

  try {
    // Dynamic import — pdf-parse is a CJS module
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdfParse = require('pdf-parse');
    const data = await pdfParse(buffer);
    rawText = data.text || '';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('PDF text extraction failed', { error: msg }, 'ocr-service');
    warnings.push(`PDF parsing failed: ${msg}`);
  }

  if (!rawText.trim()) {
    warnings.push('No text found in PDF — the document may be image-based. Manual entry recommended.');
    return emptyResult(rawText, warnings);
  }

  return extractFromText(rawText, warnings);
}

/**
 * Extract structured data from raw text (e.g. pasted or OCR output).
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

  const documentType = detectDocumentType(rawText);
  const vendorName = extractVendorName(lines);
  const vendorVatNumber = extractVatRegistration(rawText);
  const date = extractDate(rawText);
  const referenceNumber = extractReferenceNumber(rawText);
  const amounts = extractAmounts(rawText);
  const lineItems = extractLineItems(lines);

  // Calculate confidence based on how many fields we found
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
    date,
    referenceNumber,
    subtotal: amounts.subtotal,
    vatAmount: amounts.vatAmount,
    totalAmount: amounts.totalAmount,
    lineItems,
    rawText,
    confidence,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Document type detection
// ---------------------------------------------------------------------------

function detectDocumentType(text: string): ExtractedDocument['documentType'] {
  const upper = text.toUpperCase();

  if (/CREDIT\s*NOTE/i.test(upper)) return 'credit_note';
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
  // Strategy: First few non-empty lines often contain the vendor/company name.
  // Skip lines that look like document type headers or dates.
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
    // Skip lines that are purely numeric
    if (/^\d+$/.test(line)) continue;
    // Skip lines that look like addresses with postal codes
    if (/\b\d{4}\b.*\b(South Africa|SA|RSA)\b/i.test(line)) continue;

    return line;
  }

  // Fallback: look for "From:" or "Supplier:" patterns
  const fromMatch = lines.join('\n').match(/(?:From|Supplier|Vendor|Company)\s*[:-]\s*(.+)/i);
  if (fromMatch && fromMatch[1]) return fromMatch[1].trim();

  return null;
}

// ---------------------------------------------------------------------------
// VAT registration number
// ---------------------------------------------------------------------------

function extractVatRegistration(text: string): string | null {
  // SA VAT numbers are typically 10 digits
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

  // Priority: look for labelled dates first
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

  // Fallback: find date patterns anywhere in text
  // DD/MM/YYYY or DD-MM-YYYY
  const slashDate = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (slashDate) {
    const [, d, m, y] = slashDate;
    const day = d!.padStart(2, '0');
    const month = m!.padStart(2, '0');
    if (parseInt(month) >= 1 && parseInt(month) <= 12) {
      return `${y}-${month}-${day}`;
    }
  }

  // YYYY-MM-DD (ISO)
  const isoDate = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDate) {
    return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;
  }

  // DD Month YYYY
  const longDate = text.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (longDate) {
    const day = longDate[1]!.padStart(2, '0');
    const monthNum = months[longDate[2]!.toLowerCase()];
    if (monthNum) return `${longDate[3]}-${monthNum}-${day}`;
  }

  return null;
}

function parseDateString(str: string, months: Record<string, string>): string | null {
  // DD/MM/YYYY or DD-MM-YYYY
  const slashMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slashMatch) {
    const day = slashMatch[1]!.padStart(2, '0');
    const month = slashMatch[2]!.padStart(2, '0');
    if (parseInt(month) >= 1 && parseInt(month) <= 12) {
      return `${slashMatch[3]}-${month}-${day}`;
    }
  }

  // YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  // DD Month YYYY or DD Mon YYYY
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

  // Currency pattern: optional R or ZAR, then number with optional decimals and thousand separators
  const _amountPattern = /R?\s*(\d[\d\s,]*\d(?:\.\d{2})?|\d+(?:\.\d{2})?)/;

  // Total amount — look for "Total", "Amount Due", "Balance Due", "Grand Total"
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

  // VAT amount
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

  // Subtotal
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

  // If we have total and VAT but no subtotal, calculate it
  if (result.totalAmount !== null && result.vatAmount !== null && result.subtotal === null) {
    result.subtotal = Math.round((result.totalAmount - result.vatAmount) * 100) / 100;
  }

  // If we have subtotal and VAT but no total, calculate it
  if (result.subtotal !== null && result.vatAmount !== null && result.totalAmount === null) {
    result.totalAmount = Math.round((result.subtotal + result.vatAmount) * 100) / 100;
  }

  return result;
}

function parseAmount(str: string): number {
  // Remove spaces and commas used as thousand separators
  const cleaned = str.replace(/[\s,]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
}

// ---------------------------------------------------------------------------
// Line item extraction
// ---------------------------------------------------------------------------

function extractLineItems(lines: string[]): ExtractedLineItem[] {
  const items: ExtractedLineItem[] = [];

  // Look for lines that have a description followed by numbers (qty, price, total)
  // Common patterns:
  //   Description    Qty    Unit Price    Amount
  //   Some item      2      100.00        200.00

  const lineItemPattern = /^(.+?)\s+(\d+(?:\.\d+)?)\s+(?:R?\s*)?(\d[\d,]*(?:\.\d{2})?)\s+(?:R?\s*)?(\d[\d,]*(?:\.\d{2})?)$/;
  const simpleLinePattern = /^(.{3,}?)\s{2,}(?:R?\s*)?(\d[\d,]*(?:\.\d{2})?)$/;

  // Find the header line to know where items start
  let itemsStarted = false;
  const headerPattern = /(?:description|item|product|service)\s.*(?:qty|quantity|amount|price|total)/i;

  for (const line of lines) {
    if (headerPattern.test(line)) {
      itemsStarted = true;
      continue;
    }

    if (!itemsStarted && items.length === 0) {
      // Also start if we see line item patterns even without header
      const match = lineItemPattern.exec(line);
      if (match) itemsStarted = true;
    }

    if (!itemsStarted) continue;

    // Stop at totals section
    if (/^(Sub\s*[-\s]?Total|Total|VAT|Tax|Amount\s*Due|Balance\s*Due|Grand\s*Total)/i.test(line)) {
      break;
    }

    // Try full pattern: description, qty, unit price, line total
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

    // Try simple pattern: description + amount
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
  lineItems: ExtractedLineItem[];
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
    date: null,
    referenceNumber: null,
    subtotal: null,
    vatAmount: null,
    totalAmount: null,
    lineItems: [],
    rawText,
    confidence: 0,
    warnings,
  };
}
