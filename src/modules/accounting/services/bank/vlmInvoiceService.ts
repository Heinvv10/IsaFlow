/**
 * VLM Invoice Service — invoice/document extraction via vLLM
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
import { renderPdfFirstPage } from './vlmPdfRender';
import { sharedSlotLimiter, envLimit } from './vlmLimiter';

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

const EXTRACTION_PROMPT = `You are an expert accounting document reader specialised in South African business documents.
Analyse this document (a page image or its text) and extract ALL available information into the JSON structure below.
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
 * Extract document data from an image buffer using VLM.
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

/** A text layer shorter than this is treated as a scan with no usable text. */
const MIN_TEXT_LAYER_CHARS = 200;
/** A text-only read scoring below this is retried with the rendered page. */
const MIN_TEXT_ONLY_CONFIDENCE = 0.6;
const TEXT_LAYER_LIMIT = 8000;
/** pdf-parse marks every page "-- 1 of N --", even a scan's empty ones. */
const PAGE_MARKER = /-- \d+ of \d+ --/g;
/**
 * Page reads (render + VLM call) at once. Each holds a Ghostscript process and
 * then a page PNG in memory until vLLM answers, so a bulk upload of scans must
 * not start them all together. `VLM_MAX_PAGE_READS` is read once, at load.
 */
const pageReads = sharedSlotLimiter('vlm-page-reads', envLimit('VLM_MAX_PAGE_READS', 2));

/**
 * Extract from a PDF buffer using VLM.
 *
 * A digital PDF already carries its text, so that is read first as a cheap
 * text-only call. A scan, or a text read that comes back weak, goes to the
 * model as a rendered first page (with the text layer as a cross-check); the
 * better-scoring read wins. The raw PDF is never sent: vLLM rejects it.
 */
export async function extractPdfWithVlm(
  pdfBuffer: Buffer,
  rawText?: string,
): Promise<ExtractedDocument | null> {
  if (!isVlmAvailable()) return null;

  let textResult: ExtractedDocument | null = null;
  if (rawText && rawText.replace(PAGE_MARKER, '').trim().length >= MIN_TEXT_LAYER_CHARS) {
    textResult = await extractTextWithVlm(rawText);
    if (textResult && textResult.confidence >= MIN_TEXT_ONLY_CONFIDENCE) return textResult;
  }

  const imageResult = await pageReads.run(async () => {
    const pngBase64 = await renderPdfFirstPage(pdfBuffer);
    return pngBase64 ? extractWithVlm(pngBase64, 'image/png', rawText) : null;
  });
  if (imageResult) {
    const pages = pdfPageCount(rawText);
    if (pages > 1) imageResult.warnings.push(`Read from page 1 of ${pages} only — check later pages for totals.`);
  }

  if (!imageResult) return textResult;
  if (!textResult) return imageResult;
  return imageResult.confidence >= textResult.confidence ? imageResult : textResult;
}

/** Page count from pdf-parse's "-- 1 of N --" page markers; 0 when absent. */
function pdfPageCount(rawText?: string): number {
  const m = rawText?.match(/-- \d+ of (\d+) --/);
  return m?.[1] ? parseInt(m[1], 10) : 0;
}

async function extractTextWithVlm(rawText: string): Promise<ExtractedDocument | null> {
  const config = getVlmConfig();
  if (!config) return null;

  log.info('Calling vLLM for text-layer extraction', { model: config.model }, 'vlm-invoice');

  const textPrompt = 'There is no image: this is the text layer of a PDF document. '
    + `Extract all accounting data from it.\n\n${rawText.substring(0, TEXT_LAYER_LIMIT)}`;
  const content = await callVlmChat(config, EXTRACTION_PROMPT, [{ type: 'text', text: textPrompt }], 4096);
  if (!content) return null;

  const doc = parseVlmResponse(content, rawText);
  if (doc && rawText.length > TEXT_LAYER_LIMIT) {
    doc.warnings.push(`Read the first ${TEXT_LAYER_LIMIT} characters of the text only — check the rest of the document.`);
  }
  return doc;
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

    // A model that reads a credit note reports its figures NEGATIVE. Round 15
    // relied on that sign surviving all the way to `isCreditNote`, and it is
    // the only signal on a credit note the model classified as an invoice —
    // but a negative total also reaches the journal builders, where it posts a
    // purchase backwards rather than refusing. So the sign is CONVERTED into
    // the classification it means, once, here: the document is a credit note,
    // and its figures are stored positive like every other document's.
    if ((doc.totalAmount ?? 0) < 0 || (doc.subtotal ?? 0) < 0) {
      doc.documentType = 'credit_note';
      doc.subtotal = doc.subtotal === null ? null : Math.abs(doc.subtotal);
      doc.vatAmount = doc.vatAmount === null ? null : Math.abs(doc.vatAmount);
      doc.totalAmount = doc.totalAmount === null ? null : Math.abs(doc.totalAmount);
    }

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
