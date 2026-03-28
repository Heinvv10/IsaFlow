/**
 * VLM Service — Vision Language Model document extraction via vLLM (Qwen3)
 *
 * Calls the vLLM OpenAI-compatible endpoint with document images/PDFs
 * to extract structured accounting data using Qwen3-VL.
 *
 * Environment:
 *   VLLM_BASE_URL  — e.g. http://192.168.1.100:8000/v1
 *   VLLM_MODEL     — e.g. Qwen/Qwen3-VL-8B
 *   VLLM_API_KEY   — optional, defaults to "EMPTY"
 *   VLLM_TIMEOUT   — request timeout in ms, defaults to 120000
 */

import { log } from '@/lib/logger';
import type {
  ExtractedDocument,
  ExtractedLineItem,
  VendorBankDetails,
} from '@/modules/accounting/types/documentCapture.types';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function getConfig() {
  const baseUrl = process.env.VLLM_BASE_URL;
  if (!baseUrl) return null;
  return {
    baseUrl: baseUrl.replace(/\/+$/, ''),
    model: process.env.VLLM_MODEL || 'Qwen/Qwen3-VL-8B',
    apiKey: process.env.VLLM_API_KEY || 'EMPTY',
    timeout: parseInt(process.env.VLLM_TIMEOUT || '120000', 10),
  };
}

/** Returns true if vLLM is configured and reachable */
export function isVlmAvailable(): boolean {
  return !!process.env.VLLM_BASE_URL;
}

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
  "vendorBankDetails": {
    "bankName": string | null,
    "accountNumber": string | null,
    "branchCode": string | null,
    "accountType": string | null
  } | null,
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
  "lineItems": [
    {
      "description": string,
      "quantity": number | null,
      "unitPrice": number | null,
      "total": number | null,
      "vatAmount": number | null,
      "vatClassification": "standard" | "zero_rated" | "exempt" | "capital" | null,
      "glAccountSuggestion": string | null
    }
  ]
}`;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract document data from an image buffer using Qwen3 VLM on vLLM.
 * @param imageBase64 — base64-encoded image (JPEG/PNG) or PDF page render
 * @param mimeType — e.g. "image/jpeg", "image/png"
 * @param rawText — optional text layer from PDF (provides context alongside the image)
 */
export async function extractWithVlm(
  imageBase64: string,
  mimeType: string,
  rawText?: string,
): Promise<ExtractedDocument | null> {
  const config = getConfig();
  if (!config) {
    log.warn('VLM not configured — VLLM_BASE_URL not set', undefined, 'vlm-service');
    return null;
  }

  const userContent: Array<Record<string, unknown>> = [];

  // Add the image
  userContent.push({
    type: 'image_url',
    image_url: {
      url: `data:${mimeType};base64,${imageBase64}`,
    },
  });

  // If we have extracted text, include it as additional context
  let textPrompt = 'Extract all accounting data from this document image.';
  if (rawText && rawText.trim().length > 0) {
    textPrompt += `\n\nThe PDF text layer also contains the following text (use it to cross-check your extraction):\n\n${rawText.substring(0, 4000)}`;
  }

  userContent.push({
    type: 'text',
    text: textPrompt,
  });

  const body = {
    model: config.model,
    messages: [
      {
        role: 'system',
        content: EXTRACTION_PROMPT,
      },
      {
        role: 'user',
        content: userContent,
      },
    ],
    max_tokens: 4096,
    temperature: 0.1,
    stream: false,
  };

  log.info('Calling vLLM for document extraction', {
    model: config.model,
    baseUrl: config.baseUrl,
    mimeType,
    hasRawText: !!rawText,
  }, 'vlm-service');

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.timeout);

    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown error');
      log.error('vLLM request failed', {
        status: response.status,
        statusText: response.statusText,
        error: errorText.substring(0, 500),
      }, 'vlm-service');
      return null;
    }

    const result = await response.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    const content = result.choices?.[0]?.message?.content;
    if (!content) {
      log.warn('vLLM returned empty content', undefined, 'vlm-service');
      return null;
    }

    return parseVlmResponse(content, rawText || '');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('aborted') || msg.includes('AbortError')) {
      log.error('vLLM request timed out', { timeout: config.timeout }, 'vlm-service');
    } else {
      log.error('vLLM request error', { error: msg }, 'vlm-service');
    }
    return null;
  }
}

/**
 * Extract from PDF buffer using VLM.
 * Converts the first page to an image via pdf-parse metadata, or sends
 * the raw text + a rendered page if available.
 */
export async function extractPdfWithVlm(
  pdfBuffer: Buffer,
  rawText?: string,
): Promise<ExtractedDocument | null> {
  if (!isVlmAvailable()) return null;

  // For vLLM with Qwen3-VL, we can send the PDF as a base64 image
  // vLLM handles PDF rendering internally for vision models,
  // but most reliably we send as base64 and let the model process it.
  // Some vLLM deployments support PDF directly via data URL.
  const base64 = pdfBuffer.toString('base64');

  // Try sending as PDF first (some vLLM+Qwen setups handle this)
  let result = await extractWithVlm(base64, 'application/pdf', rawText);
  if (result) return result;

  // Fallback: try converting PDF first page to PNG via canvas if available
  try {
    const pngBase64 = await renderPdfFirstPage(pdfBuffer);
    if (pngBase64) {
      result = await extractWithVlm(pngBase64, 'image/png', rawText);
      if (result) return result;
    }
  } catch (err) {
    log.warn('PDF-to-image conversion not available', {
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-service');
  }

  return null;
}

// ---------------------------------------------------------------------------
// PDF to image rendering (optional, uses pdf-poppler or similar)
// ---------------------------------------------------------------------------

async function renderPdfFirstPage(pdfBuffer: Buffer): Promise<string | null> {
  // Try using pdf2pic if available (optional dependency)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pdf2pic = require('pdf2pic') as { fromBuffer: (buf: Buffer, opts: Record<string, unknown>) => (pageNumber: number, options?: Record<string, unknown>) => Promise<{ base64?: string }> };
    const converter = pdf2pic.fromBuffer(pdfBuffer, {
      density: 200,
      format: 'png',
      width: 1600,
      height: 2200,
      saveFilename: 'page',
      savePath: '/tmp',
    });
    const result = await converter(1, { saveFilename: 'vlm_page', savePath: '/tmp' });
    if (result.base64) return result.base64;
  } catch {
    // pdf2pic not installed — that's fine, we'll skip image conversion
  }

  return null;
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

function parseVlmResponse(content: string, rawText: string): ExtractedDocument | null {
  // Strip markdown code fences if present
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }

  // Handle Qwen3's <think>...</think> tags — strip reasoning, keep the JSON
  if (jsonStr.includes('<think>')) {
    jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  }

  // Try to extract JSON object if there's surrounding text
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    jsonStr = jsonMatch[0];
  }

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const lineItems = parseLineItems(parsed.lineItems);
    const bankDetails = parseBankDetails(parsed.vendorBankDetails);

    const doc: ExtractedDocument = {
      documentType: validateDocumentType(parsed.documentType as string),
      vendorName: asString(parsed.vendorName),
      vendorVatNumber: asString(parsed.vendorVatNumber),
      vendorAddress: asString(parsed.vendorAddress),
      vendorBankDetails: bankDetails,
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
      lineItems,
      rawText,
      confidence: computeVlmConfidence(parsed),
      warnings: [],
      extractionMethod: 'vlm',
    };

    // Cross-validate amounts
    const amountWarnings = validateAmounts(doc);
    doc.warnings.push(...amountWarnings);

    log.info('VLM extraction successful', {
      documentType: doc.documentType,
      confidence: doc.confidence,
      lineItemCount: doc.lineItems.length,
      warningCount: doc.warnings.length,
    }, 'vlm-service');

    return doc;
  } catch (err) {
    log.error('Failed to parse VLM JSON response', {
      error: err instanceof Error ? err.message : String(err),
      responsePreview: content.substring(0, 300),
    }, 'vlm-service');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function asString(val: unknown): string | null {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s.length > 0 ? s : null;
}

function asNumber(val: unknown): number | null {
  if (val === null || val === undefined) return null;
  const n = typeof val === 'number' ? val : parseFloat(String(val));
  return isNaN(n) ? null : Math.round(n * 100) / 100;
}

function asDateString(val: unknown): string | null {
  if (!val) return null;
  const s = String(val).trim();
  // Validate YYYY-MM-DD format
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return s;
  }
  return null;
}

function parseLineItems(val: unknown): ExtractedLineItem[] {
  if (!Array.isArray(val)) return [];
  return val
    .filter((item): item is Record<string, unknown> => item && typeof item === 'object')
    .map((item) => ({
      description: asString(item.description) || 'Unknown item',
      quantity: asNumber(item.quantity),
      unitPrice: asNumber(item.unitPrice) ?? asNumber(item.unit_price),
      total: asNumber(item.total) ?? asNumber(item.lineTotal) ?? asNumber(item.line_total),
      vatAmount: asNumber(item.vatAmount) ?? asNumber(item.vat_amount),
      vatClassification: validateVatClassification(item.vatClassification ?? item.vat_classification),
      glAccountSuggestion: asString(item.glAccountSuggestion) ?? asString(item.gl_account_suggestion),
    }));
}

function validateVatClassification(val: unknown): ExtractedLineItem['vatClassification'] {
  const valid = ['standard', 'zero_rated', 'exempt', 'capital'];
  const s = asString(val);
  return s && valid.includes(s) ? s as ExtractedLineItem['vatClassification'] : null;
}

function parseBankDetails(val: unknown): VendorBankDetails | null {
  if (!val || typeof val !== 'object') return null;
  const obj = val as Record<string, unknown>;
  const details: VendorBankDetails = {
    bankName: asString(obj.bankName) ?? asString(obj.bank_name),
    accountNumber: asString(obj.accountNumber) ?? asString(obj.account_number),
    branchCode: asString(obj.branchCode) ?? asString(obj.branch_code),
    accountType: asString(obj.accountType) ?? asString(obj.account_type),
  };
  // Only return if at least one field is populated
  if (details.bankName || details.accountNumber || details.branchCode) return details;
  return null;
}

function computeVlmConfidence(parsed: Record<string, unknown>): number {
  let score = 0;
  const weights = {
    vendorName: 0.15,
    date: 0.15,
    referenceNumber: 0.10,
    totalAmount: 0.20,
    vatAmount: 0.10,
    lineItems: 0.10,
    documentType: 0.05,
    dueDate: 0.05,
    vendorVatNumber: 0.05,
    customerName: 0.05,
  };

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
    const diff = Math.abs(expected - doc.totalAmount);
    if (diff > 0.02) {
      warnings.push(`Amount mismatch: subtotal (${doc.subtotal}) + VAT (${doc.vatAmount}) = ${expected}, but total is ${doc.totalAmount}`);
    }
  }

  if (doc.subtotal !== null && doc.vatRate !== null && doc.vatAmount !== null) {
    const expectedVat = Math.round(doc.subtotal * (doc.vatRate / 100) * 100) / 100;
    const diff = Math.abs(expectedVat - doc.vatAmount);
    if (diff > 1) {
      warnings.push(`VAT calculation may be incorrect: ${doc.vatRate}% of ${doc.subtotal} = ${expectedVat}, but extracted VAT is ${doc.vatAmount}`);
    }
  }

  // Validate line item totals sum to subtotal
  if (doc.lineItems.length > 0 && doc.subtotal !== null) {
    const lineSum = doc.lineItems.reduce((sum, li) => sum + (li.total ?? 0), 0);
    const roundedSum = Math.round(lineSum * 100) / 100;
    if (roundedSum > 0) {
      const diff = Math.abs(roundedSum - doc.subtotal);
      if (diff > 1) {
        warnings.push(`Line items sum (${roundedSum}) differs from subtotal (${doc.subtotal})`);
      }
    }
  }

  return warnings;
}
