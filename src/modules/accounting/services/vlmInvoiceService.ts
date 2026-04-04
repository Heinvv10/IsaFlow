/**
 * VLM Invoice Service — invoice/document extraction via vLLM (Qwen3-VL)
 *
 * Handles: invoice, credit_note, receipt, purchase_order, delivery_note
 * extraction from images and PDFs.
 */

import { log } from '@/lib/logger';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import {
  getVlmConfig,
  isVlmAvailable,
  callVlmChat,
  cleanVlmJson,
  buildImageContent,
  asString,
  asNumber,
  asDateString,
  parseLineItems,
  parseBankDetails,
} from './vlmCore';

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an expert accounting document reader specialised in South African business documents.
Analyse this document image and extract ALL available information into the JSON structure below.
Be precise with numbers — do not guess amounts. If a field is not visible, use null.

For South African documents:
- VAT registration numbers are 10 digits
- Standard VAT rate is 15%
- Currency is typically ZAR (South African Rand) shown as "R"
- Common banks: ABSA, FNB, Standard Bank, Nedbank, Capitec

Return ONLY valid JSON (no markdown, no explanation) matching this schema:

{
  "documentType": "invoice" | "credit_note" | "receipt" | "statement" | "purchase_order" | "delivery_note" | "unknown",
  "vendorName": string | null,
  "vendorVatNumber": string | null,
  "vendorAddress": string | null,
  "vendorBankDetails": { "bankName": string | null, "accountNumber": string | null, "branchCode": string | null, "accountType": string | null } | null,
  "customerName": string | null,
  "customerVatNumber": string | null,
  "date": "YYYY-MM-DD" | null,
  "dueDate": "YYYY-MM-DD" | null,
  "paymentTerms": string | null,
  "referenceNumber": string | null,
  "purchaseOrderRef": string | null,
  "currency": "ZAR" | string | null,
  "subtotal": number | null,
  "vatAmount": number | null,
  "vatRate": number | null,
  "totalAmount": number | null,
  "lineItems": [{ "description": string, "quantity": number | null, "unitPrice": number | null, "total": number | null, "vatAmount": number | null, "vatClassification": "standard" | "zero_rated" | "exempt" | "capital" | null, "glAccountSuggestion": string | null }]
}`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract document data from an image buffer using Qwen3 VLM.
 * @param imageBase64 — base64-encoded image (JPEG/PNG) or PDF page render
 * @param mimeType — e.g. "image/jpeg", "image/png"
 * @param rawText — optional PDF text layer for cross-check context
 */
export async function extractWithVlm(
  imageBase64: string,
  mimeType: string,
  rawText?: string,
): Promise<ExtractedDocument | null> {
  const config = getVlmConfig();
  if (!config) {
    log.warn('VLM not configured — VLLM_BASE_URL not set', undefined, 'vlm-invoice');
    return null;
  }

  let textPrompt = 'Extract all accounting data from this document image.';
  if (rawText && rawText.trim().length > 0) {
    textPrompt += `\n\nThe PDF text layer also contains the following text (use it to cross-check your extraction):\n\n${rawText.substring(0, 4000)}`;
  }

  log.info('Calling vLLM for document extraction', {
    model: config.model,
    baseUrl: config.baseUrl,
    mimeType,
    hasRawText: !!rawText,
  }, 'vlm-invoice');

  const userContent = buildImageContent(imageBase64, mimeType, textPrompt);
  const content = await callVlmChat(config, EXTRACTION_PROMPT, userContent, 4096);
  if (!content) return null;

  return parseVlmResponse(content, rawText || '');
}

/**
 * Extract from PDF buffer using VLM.
 * Tries sending the PDF directly, then falls back to rendering the first page.
 */
export async function extractPdfWithVlm(
  pdfBuffer: Buffer,
  rawText?: string,
): Promise<ExtractedDocument | null> {
  if (!isVlmAvailable()) return null;

  const base64 = pdfBuffer.toString('base64');

  let result = await extractWithVlm(base64, 'application/pdf', rawText);
  if (result) return result;

  try {
    const pngBase64 = await renderPdfFirstPage(pdfBuffer);
    if (pngBase64) {
      result = await extractWithVlm(pngBase64, 'image/png', rawText);
      if (result) return result;
    }
  } catch (err) {
    log.warn('PDF-to-image conversion not available', {
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-invoice');
  }

  return null;
}

// ---------------------------------------------------------------------------
// PDF to image rendering (optional dependency — pdf2pic)
// ---------------------------------------------------------------------------

async function renderPdfFirstPage(pdfBuffer: Buffer): Promise<string | null> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdf2pic = require('pdf2pic') as {
      fromBuffer: (buf: Buffer, opts: Record<string, unknown>) => (
        pageNumber: number,
        options?: Record<string, unknown>
      ) => Promise<{ base64?: string }>;
    };
    const converter = pdf2pic.fromBuffer(pdfBuffer, {
      density: 200, format: 'png', width: 1600, height: 2200,
      saveFilename: 'page', savePath: '/tmp',
    });
    const result = await converter(1, { saveFilename: 'vlm_page', savePath: '/tmp' });
    if (result.base64) return result.base64;
  } catch {
    // pdf2pic not installed — skip image conversion
  }
  return null;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseVlmResponse(content: string, rawText: string): ExtractedDocument | null {
  const jsonStr = cleanVlmJson(content);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const doc: ExtractedDocument = {
      documentType: validateDocumentType(parsed.documentType as string),
      vendorName: asString(parsed.vendorName),
      vendorVatNumber: asString(parsed.vendorVatNumber),
      vendorAddress: asString(parsed.vendorAddress),
      vendorBankDetails: parseBankDetails(parsed.vendorBankDetails),
      customerName: asString(parsed.customerName),
      customerVatNumber: asString(parsed.customerVatNumber),
      date: asDateString(parsed.date),
      dueDate: asDateString(parsed.dueDate),
      paymentTerms: asString(parsed.paymentTerms),
      referenceNumber: asString(parsed.referenceNumber),
      purchaseOrderRef: asString(parsed.purchaseOrderRef),
      currency: asString(parsed.currency) || 'ZAR',
      subtotal: asNumber(parsed.subtotal),
      vatAmount: asNumber(parsed.vatAmount),
      vatRate: asNumber(parsed.vatRate),
      totalAmount: asNumber(parsed.totalAmount),
      lineItems: parseLineItems(parsed.lineItems),
      rawText,
      confidence: computeConfidence(parsed),
      warnings: [],
      extractionMethod: 'vlm',
    };

    doc.warnings.push(...validateAmounts(doc));

    log.info('VLM extraction successful', {
      documentType: doc.documentType,
      confidence: doc.confidence,
      lineItemCount: doc.lineItems.length,
      warningCount: doc.warnings.length,
    }, 'vlm-invoice');

    return doc;
  } catch (err) {
    log.error('Failed to parse VLM JSON response', {
      error: err instanceof Error ? err.message : String(err),
      responsePreview: content.substring(0, 300),
    }, 'vlm-invoice');
    return null;
  }
}

function validateDocumentType(val: string | undefined): ExtractedDocument['documentType'] {
  const valid: ExtractedDocument['documentType'][] = [
    'invoice', 'credit_note', 'receipt', 'statement',
    'purchase_order', 'delivery_note', 'unknown',
  ];
  if (val && valid.includes(val as ExtractedDocument['documentType'])) {
    return val as ExtractedDocument['documentType'];
  }
  return 'unknown';
}

function computeConfidence(parsed: Record<string, unknown>): number {
  const weights = {
    vendorName: 0.15, date: 0.15, referenceNumber: 0.10, totalAmount: 0.20,
    vatAmount: 0.10, lineItems: 0.10, documentType: 0.05, dueDate: 0.05,
    vendorVatNumber: 0.05, customerName: 0.05,
  };
  let score = 0;
  if (parsed.vendorName) score += weights.vendorName;
  if (parsed.date) score += weights.date;
  if (parsed.referenceNumber) score += weights.referenceNumber;
  if (asNumber(parsed.totalAmount) !== null && asNumber(parsed.totalAmount)! > 0) score += weights.totalAmount;
  if (asNumber(parsed.vatAmount) !== null) score += weights.vatAmount;
  if (Array.isArray(parsed.lineItems) && parsed.lineItems.length > 0) score += weights.lineItems;
  if (parsed.documentType && parsed.documentType !== 'unknown') score += weights.documentType;
  if (parsed.dueDate) score += weights.dueDate;
  if (parsed.vendorVatNumber) score += weights.vendorVatNumber;
  if (parsed.customerName) score += weights.customerName;
  return Math.round(score * 100) / 100;
}

function validateAmounts(doc: ExtractedDocument): string[] {
  const warnings: string[] = [];
  if (doc.subtotal !== null && doc.vatAmount !== null && doc.totalAmount !== null) {
    const expected = Math.round((doc.subtotal + doc.vatAmount) * 100) / 100;
    if (Math.abs(expected - doc.totalAmount) > 0.02) {
      warnings.push(`Amount mismatch: subtotal (${doc.subtotal}) + VAT (${doc.vatAmount}) = ${expected}, but total is ${doc.totalAmount}`);
    }
  }
  if (doc.subtotal !== null && doc.vatRate !== null && doc.vatAmount !== null) {
    const expectedVat = Math.round(doc.subtotal * (doc.vatRate / 100) * 100) / 100;
    if (Math.abs(expectedVat - doc.vatAmount) > 1) {
      warnings.push(`VAT calculation may be incorrect: ${doc.vatRate}% of ${doc.subtotal} = ${expectedVat}, but extracted VAT is ${doc.vatAmount}`);
    }
  }
  if (doc.lineItems.length > 0 && doc.subtotal !== null) {
    const lineSum = Math.round(doc.lineItems.reduce((sum, li) => sum + (li.total ?? 0), 0) * 100) / 100;
    if (lineSum > 0 && Math.abs(lineSum - doc.subtotal) > 1) {
      warnings.push(`Line items sum (${lineSum}) differs from subtotal (${doc.subtotal})`);
    }
  }
  return warnings;
}
