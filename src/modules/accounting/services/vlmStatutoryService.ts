/**
 * VLM Statutory Service — statutory/compliance document extraction via vLLM (Qwen3-VL)
 *
 * Handles: CIPC certificates, SARS tax clearance, B-BBEE certificates, VAT registrations.
 */

import { log } from '@/lib/logger';
import type {
  ExtractedStatutoryDoc,
  StatutoryDocType,
} from '@/modules/accounting/types/documentCapture.types';
import {
  getVlmConfig,
  callVlmChat,
  cleanVlmJson,
  buildImageContent,
  asString,
  asNumber,
  asDateString,
} from './vlmCore';

// ---------------------------------------------------------------------------
// Extraction prompt
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract statutory document data using VLM.
 */
export async function extractStatutoryDocWithVlm(
  base64: string,
  mimeType: string,
  docTypeHint?: string,
): Promise<ExtractedStatutoryDoc | null> {
  const config = getVlmConfig();
  if (!config) return null;

  let textPrompt = 'Extract all information from this statutory document.';
  if (docTypeHint) {
    textPrompt += ` This is expected to be a ${docTypeHint} document.`;
  }

  log.info('Calling vLLM for statutory doc extraction', {
    model: config.model,
    docTypeHint,
  }, 'vlm-statutory');

  const userContent = buildImageContent(base64, mimeType, textPrompt);
  const content = await callVlmChat(config, STATUTORY_DOC_PROMPT, userContent, 2048);
  if (!content) return null;

  return parseStatutoryDocResponse(content);
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

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
    }, 'vlm-statutory');

    return result;
  } catch (err) {
    log.error('Failed to parse statutory doc VLM response', {
      error: err instanceof Error ? err.message : String(err),
    }, 'vlm-statutory');
    return null;
  }
}
