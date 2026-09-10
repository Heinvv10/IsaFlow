/**
 * OCR Regex Extraction Helpers
 * Pattern-based field extraction from invoice/receipt text.
 * Optimised for South African documents.
 */

import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { parseAmount } from './ocrAmountParsing';
import {
  SUBTOTAL_PATTERNS,
  SUMMARY_LINE_START,
} from './ocrAmountPatterns';
import {
  extractTotalCandidates,
  extractVatAmount,
  reconcileNetAgainstTotal,
  selectTotalAmount,
} from './ocrAmountReconciliation';

export interface ExtractedAmounts {
  subtotal: number | null;
  vatAmount: number | null;
  totalAmount: number | null;
  /** What the reader could not settle on its own — surfaced on the capture screen. */
  warnings: string[];
}

export interface RegexLineItem {
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  total: number | null;
}

export function detectDocumentType(text: string): ExtractedDocument['documentType'] {
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

export function extractVendorName(lines: string[]): string | null {
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

export function extractVatRegistration(text: string): string | null {
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

const MONTHS: Record<string, string> = { jan:'01',january:'01',feb:'02',february:'02',mar:'03',march:'03',apr:'04',april:'04',may:'05',jun:'06',june:'06',jul:'07',july:'07',aug:'08',august:'08',sep:'09',september:'09',oct:'10',october:'10',nov:'11',november:'11',dec:'12',december:'12' };

function parseDateString(str: string): string | null {
  const slashMatch = str.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (slashMatch) {
    const day = slashMatch[1]!.padStart(2, '0');
    const month = slashMatch[2]!.padStart(2, '0');
    if (parseInt(month) >= 1 && parseInt(month) <= 12) return `${slashMatch[3]}-${month}-${day}`;
  }

  const isoMatch = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (isoMatch) return `${isoMatch[1]}-${isoMatch[2]}-${isoMatch[3]}`;

  const longMatch = str.match(/^(\d{1,2})\s+(\w+)\s+(\d{4})/);
  if (longMatch) {
    const monthNum = MONTHS[longMatch[2]!.toLowerCase()];
    if (monthNum) return `${longMatch[3]}-${monthNum}-${longMatch[1]!.padStart(2, '0')}`;
  }

  return null;
}

export function extractDate(text: string): string | null {
  const labelledPatterns = [
    /(?:Invoice|Document|Tax Invoice|Statement)\s*Date\s*[:-]?\s*(.+)/i,
    /Date\s*[:-]\s*(.+)/i,
    /Dated?\s*[:-]\s*(.+)/i,
  ];

  for (const pattern of labelledPatterns) {
    const match = text.match(pattern);
    if (match && match[1]) {
      const parsed = parseDateString(match[1].trim());
      if (parsed) return parsed;
    }
  }

  const slashDate = text.match(/\b(\d{1,2})[/-](\d{1,2})[/-](\d{4})\b/);
  if (slashDate) {
    const day = slashDate[1]!.padStart(2, '0');
    const month = slashDate[2]!.padStart(2, '0');
    if (parseInt(month) >= 1 && parseInt(month) <= 12) return `${slashDate[3]}-${month}-${day}`;
  }

  const isoDate = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (isoDate) return `${isoDate[1]}-${isoDate[2]}-${isoDate[3]}`;

  const longDate = text.match(/\b(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})\b/i);
  if (longDate) {
    const day = longDate[1]!.padStart(2, '0');
    const monthNum = MONTHS[longDate[2]!.toLowerCase()];
    if (monthNum) return `${longDate[3]}-${monthNum}-${day}`;
  }

  return null;
}

export function extractReferenceNumber(text: string): string | null {
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
    if (match && match[1] && match[1].length >= 3) return match[1].trim();
  }
  return null;
}

export function extractAmounts(text: string): ExtractedAmounts {
  const result: ExtractedAmounts = { subtotal: null, vatAmount: null, totalAmount: null, warnings: [] };

  // EVERY figure that could be the total, not the leftmost one. `String.match`
  // returned the first hit, so a sectioned till slip ("Food Total 200.00 / …
  // TOTAL 287.50") posted its first section as the amount payable — see
  // `extractTotalCandidates`. More than one distinct figure is declared, not
  // resolved — see `selectTotalAmount`.
  const totalCandidates = extractTotalCandidates(text);
  // The bottom-most candidate is the provisional total the VAT plausibility
  // test uses: `isPlausibleVatAmount` rejects a candidate too large for the
  // total, and a section subtotal in that role rejects the real VAT line.
  const provisionalTotal = totalCandidates.length > 0
    ? totalCandidates[totalCandidates.length - 1]!
    : null;

  // Read the subtotal BEFORE the VAT: the VAT selection below cross-checks
  // candidates against it, so it has to exist by then.
  for (const pattern of SUBTOTAL_PATTERNS) {
    const match = text.match(pattern);
    if (match && match[1]) { result.subtotal = parseAmount(match[1]); break; }
  }

  result.vatAmount = extractVatAmount(text, result.subtotal, provisionalTotal);

  const selectedTotal = selectTotalAmount(totalCandidates);
  result.totalAmount = selectedTotal.totalAmount;
  if (selectedTotal.warning) result.warnings.push(selectedTotal.warning);

  if (result.totalAmount !== null && result.vatAmount !== null && result.subtotal === null) {
    const derived = Math.round((result.totalAmount - result.vatAmount) * 100) / 100;
    // A negative subtotal is not a subtotal. It means the VAT candidate was
    // junk, and passing it on put an expense debit of minus forty-one million
    // in front of whoever was looking at the capture screen.
    result.subtotal = derived < 0 ? null : derived;
  }
  if (result.subtotal !== null && result.vatAmount !== null && result.totalAmount === null) {
    result.totalAmount = Math.round((result.subtotal + result.vatAmount) * 100) / 100;
  }
  // A printed subtotal the document's own total and tax contradict — see
  // `reconcileNetAgainstTotal` for which figure wins and why it is conditional.
  const reconciled = reconcileNetAgainstTotal(result.subtotal, result.vatAmount, result.totalAmount);
  result.subtotal = reconciled.subtotal;
  if (reconciled.warning) result.warnings.push(reconciled.warning);

  return result;
}

export function extractLineItems(lines: string[]): RegexLineItem[] {
  const items: RegexLineItem[] = [];
  const lineItemPattern = /^(.+?)\s+(\d+(?:\.\d+)?)\s+(?:R?\s*)?(\d[\d,]*(?:\.\d{2})?)\s+(?:R?\s*)?(\d[\d,]*(?:\.\d{2})?)$/;
  const simpleLinePattern = /^(.{3,}?)\s{2,}(?:R?\s*)?(\d[\d,]*(?:\.\d{2})?)$/;
  const headerPattern = /(?:description|item|product|service)\s.*(?:qty|quantity|amount|price|total)/i;

  let itemsStarted = false;

  for (const line of lines) {
    if (headerPattern.test(line)) { itemsStarted = true; continue; }
    if (!itemsStarted && items.length === 0) {
      const match = lineItemPattern.exec(line);
      if (match) itemsStarted = true;
    }
    if (!itemsStarted) continue;
    // The terminator is the vocabulary itself, not a second hand-spelled copy
    // of it: while this list knew only `Sub[\s-]*Total`, a `Nett Total`
    // summary line was collected as a line item.
    if (SUMMARY_LINE_START.test(line)) break;

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

export function computeConfidence(fields: {
  vendorName: string | null;
  date: string | null;
  referenceNumber: string | null;
  totalAmount: number | null;
  vatAmount: number | null;
  lineItems: RegexLineItem[];
}): number {
  let score = 0;
  if (fields.vendorName) score += 0.2;
  if (fields.date) score += 0.2;
  if (fields.referenceNumber) score += 0.15;
  if (fields.totalAmount !== null && fields.totalAmount > 0) score += 0.25;
  if (fields.vatAmount !== null && fields.vatAmount > 0) score += 0.1;
  if (fields.lineItems.length > 0) score += 0.1;
  return Math.round(score * 100) / 100;
}

export function emptyResult(rawText: string, warnings: string[]): ExtractedDocument {
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
