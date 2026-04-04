/**
 * OCR Service — Document data extraction with VLM + regex fallback
 *
 * Primary:  Qwen3 VLM on vLLM (handles images AND text-based PDFs)
 * Fallback: Pattern-based regex extraction for PDFs with text layers
 *
 * Optimised for South African invoices and receipts.
 */

import { log } from '@/lib/logger';
import type { ExtractedDocument } from '@/modules/accounting/types/documentCapture.types';
import { extractWithVlm, extractPdfWithVlm, isVlmAvailable } from './vlmService';
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
} from './ocrExtractionService';

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
