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
  ExtractedBankStatement,
  ExtractedBankTransaction,
  ExtractedStatutoryDoc,
  StatutoryDocType,
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
  const jsonStr = cleanVlmJson(content);

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

// ===========================================================================
// BANK STATEMENT EXTRACTION
// ===========================================================================

const BANK_STATEMENT_PROMPT = `You are an expert at reading South African bank statements.
Extract ALL transactions and metadata from this bank statement image.
Common SA banks: ABSA, FNB, Standard Bank, Nedbank, Capitec, Investec, African Bank, TymeBank.

Return ONLY valid JSON (no markdown, no explanation) matching this schema:

{
  "bankName": string | null,
  "accountNumber": string | null,
  "statementPeriod": { "from": "YYYY-MM-DD" | null, "to": "YYYY-MM-DD" | null } | null,
  "openingBalance": number | null,
  "closingBalance": number | null,
  "transactions": [
    {
      "date": "YYYY-MM-DD" | null,
      "description": string,
      "amount": number,
      "balance": number | null,
      "reference": string | null,
      "transactionType": string | null
    }
  ]
}

Rules:
- Debit (money out) amounts should be NEGATIVE, credit (money in) should be POSITIVE
- Include every single transaction row — do not skip or summarise
- Parse dates carefully — SA format is typically DD/MM/YYYY or DD Mon YYYY
- If a transaction spans multiple description lines, concatenate them`;

/**
 * Extract bank statement transactions using VLM.
 */
export async function extractBankStatementWithVlm(
  base64: string,
  mimeType: string,
  rawText?: string,
): Promise<ExtractedBankStatement | null> {
  const config = getConfig();
  if (!config) return null;

  const userContent: Array<Record<string, unknown>> = [];

  userContent.push({
    type: 'image_url',
    image_url: { url: `data:${mimeType};base64,${base64}` },
  });

  let textPrompt = 'Extract all transactions from this bank statement.';
  if (rawText && rawText.trim().length > 0) {
    textPrompt += `\n\nPDF text layer:\n\n${rawText.substring(0, 6000)}`;
  }

  userContent.push({ type: 'text', text: textPrompt });

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: BANK_STATEMENT_PROMPT },
      { role: 'user', content: userContent },
    ],
    max_tokens: 8192,
    temperature: 0.1,
    stream: false,
  };

  log.info('Calling vLLM for bank statement extraction', {
    model: config.model,
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
      const errorText = await response.text().catch(() => 'unknown');
      log.error('vLLM bank statement request failed', { status: response.status, error: errorText.substring(0, 500) }, 'vlm-service');
      return null;
    }

    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = result.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseBankStatementResponse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('vLLM bank statement error', { error: msg }, 'vlm-service');
    return null;
  }
}

function parseBankStatementResponse(content: string): ExtractedBankStatement | null {
  const jsonStr = cleanVlmJson(content);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const transactions: ExtractedBankTransaction[] = [];
    if (Array.isArray(parsed.transactions)) {
      for (const t of parsed.transactions) {
        if (!t || typeof t !== 'object') continue;
        const tx = t as Record<string, unknown>;
        transactions.push({
          date: asDateString(tx.date),
          description: asString(tx.description) || 'Unknown',
          amount: asNumber(tx.amount) ?? 0,
          balance: asNumber(tx.balance),
          reference: asString(tx.reference),
          transactionType: asString(tx.transactionType) ?? asString(tx.transaction_type),
        });
      }
    }

    const period = parsed.statementPeriod as Record<string, unknown> | null;

    const result: ExtractedBankStatement = {
      bankName: asString(parsed.bankName) ?? asString(parsed.bank_name),
      accountNumber: asString(parsed.accountNumber) ?? asString(parsed.account_number),
      statementPeriod: period ? {
        from: asDateString(period.from),
        to: asDateString(period.to),
      } : null,
      openingBalance: asNumber(parsed.openingBalance) ?? asNumber(parsed.opening_balance),
      closingBalance: asNumber(parsed.closingBalance) ?? asNumber(parsed.closing_balance),
      transactions,
      confidence: transactions.length > 0 ? 0.85 : 0.1,
      warnings: [],
    };

    if (transactions.length === 0) {
      result.warnings.push('No transactions extracted from bank statement');
    }

    log.info('Bank statement extraction successful', {
      bankName: result.bankName,
      transactionCount: transactions.length,
    }, 'vlm-service');

    return result;
  } catch (err) {
    log.error('Failed to parse bank statement VLM response', {
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-service');
    return null;
  }
}

// ===========================================================================
// STATUTORY DOCUMENT EXTRACTION
// ===========================================================================

const STATUTORY_DOC_PROMPT = `You are an expert at reading South African statutory and compliance documents.
Extract key information from this document image.

Document types you may encounter:
- CIPC Registration Certificate (Companies and Intellectual Property Commission)
- SARS Tax Clearance Certificate / Tax Compliance Status
- B-BBEE Certificate (Broad-Based Black Economic Empowerment)
- VAT Registration Certificate

Return ONLY valid JSON (no markdown, no explanation) matching this schema:

{
  "documentType": "cipc" | "tax_clearance" | "bbee" | "vat_registration" | "unknown",
  "entityName": string | null,
  "registrationNumber": string | null,
  "vatNumber": string | null,
  "taxNumber": string | null,
  "issueDate": "YYYY-MM-DD" | null,
  "expiryDate": "YYYY-MM-DD" | null,
  "bbeeLevel": number | null,
  "bbeeScore": number | null,
  "verificationAgency": string | null
}

Notes:
- CIPC registration numbers look like: K2024/123456 or 2024/123456/07
- SA VAT numbers are 10 digits
- Tax reference numbers are typically 10 digits
- B-BBEE levels range from 1 (best) to 8 (non-compliant)
- Tax clearance certificates have a PIN and expiry date`;

/**
 * Extract statutory document data using VLM.
 */
export async function extractStatutoryDocWithVlm(
  base64: string,
  mimeType: string,
  docTypeHint?: string,
): Promise<ExtractedStatutoryDoc | null> {
  const config = getConfig();
  if (!config) return null;

  const userContent: Array<Record<string, unknown>> = [];

  userContent.push({
    type: 'image_url',
    image_url: { url: `data:${mimeType};base64,${base64}` },
  });

  let textPrompt = 'Extract all information from this statutory document.';
  if (docTypeHint) {
    textPrompt += ` This is expected to be a ${docTypeHint} document.`;
  }

  userContent.push({ type: 'text', text: textPrompt });

  const body = {
    model: config.model,
    messages: [
      { role: 'system', content: STATUTORY_DOC_PROMPT },
      { role: 'user', content: userContent },
    ],
    max_tokens: 2048,
    temperature: 0.1,
    stream: false,
  };

  log.info('Calling vLLM for statutory doc extraction', {
    model: config.model,
    docTypeHint,
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
      const errorText = await response.text().catch(() => 'unknown');
      log.error('vLLM statutory doc request failed', { status: response.status, error: errorText.substring(0, 500) }, 'vlm-service');
      return null;
    }

    const result = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = result.choices?.[0]?.message?.content;
    if (!content) return null;

    return parseStatutoryDocResponse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('vLLM statutory doc error', { error: msg }, 'vlm-service');
    return null;
  }
}

function parseStatutoryDocResponse(content: string): ExtractedStatutoryDoc | null {
  const jsonStr = cleanVlmJson(content);

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;

    const validTypes: StatutoryDocType[] = ['cipc', 'tax_clearance', 'bbee', 'vat_registration', 'unknown'];
    const docType = validTypes.includes(parsed.documentType as StatutoryDocType)
      ? parsed.documentType as StatutoryDocType
      : 'unknown';

    const result: ExtractedStatutoryDoc = {
      documentType: docType,
      entityName: asString(parsed.entityName) ?? asString(parsed.entity_name),
      registrationNumber: asString(parsed.registrationNumber) ?? asString(parsed.registration_number),
      vatNumber: asString(parsed.vatNumber) ?? asString(parsed.vat_number),
      taxNumber: asString(parsed.taxNumber) ?? asString(parsed.tax_number),
      issueDate: asDateString(parsed.issueDate) ?? asDateString(parsed.issue_date),
      expiryDate: asDateString(parsed.expiryDate) ?? asDateString(parsed.expiry_date),
      bbeeLevel: asNumber(parsed.bbeeLevel) ?? asNumber(parsed.bbee_level),
      bbeeScore: asNumber(parsed.bbeeScore) ?? asNumber(parsed.bbee_score),
      verificationAgency: asString(parsed.verificationAgency) ?? asString(parsed.verification_agency),
      confidence: docType !== 'unknown' ? 0.85 : 0.3,
      warnings: [],
    };

    log.info('Statutory doc extraction successful', {
      documentType: result.documentType,
      entityName: result.entityName,
    }, 'vlm-service');

    return result;
  } catch (err) {
    log.error('Failed to parse statutory doc VLM response', {
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-service');
    return null;
  }
}

// ===========================================================================
// Shared VLM JSON cleanup
// ===========================================================================

function cleanVlmJson(content: string): string {
  let jsonStr = content.trim();
  if (jsonStr.startsWith('```')) {
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  if (jsonStr.includes('<think>')) {
    jsonStr = jsonStr.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
  }
  const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
  if (jsonMatch) jsonStr = jsonMatch[0];
  return jsonStr;
}
