/**
 * POST /api/onboarding/extract-id
 * Extracts director name and ID number from an uploaded ID document / passport
 * using the VLM (configured via VLM_MODEL env var).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { checkAiRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { pdfToImage } from '@/lib/pdf-to-image';
import { callVlmChat, getVlmConfig } from '@/modules/accounting/services/bank/vlmCore';

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

const SYSTEM_PROMPT = `You are a document data extraction assistant specialised in South African identity documents \
(ID cards, smart ID cards, passports, driver's licenses).

On SA smart ID cards and green ID books, the name is split across two labelled fields:
  "Surname:" — the family name (e.g. VAN NIEKERK)
  "Names:"   — the given name(s) (e.g. HANDRE)

Rules:
- Copy the text VERBATIM from the "Surname:" and "Names:" labels. Do not merge, expand, or infer letters.
- If a letter is unclear, prefer the plainest reading; never invent extra letters.
- For passports, use the "Surname" and "Given names" fields in the MRZ / visual zone.
- Return ONLY a valid JSON object with exactly these keys: surname, givenNames, idNumber.
- If a field cannot be read with confidence, return an empty string for that field.
- No markdown, no prose, no commentary.`;

const USER_PROMPT = `Extract the surname, given names, and ID/passport number from this identity document. \
Read each field letter-by-letter from the labelled zones. \
Respond with only the JSON object: {"surname": "...", "givenNames": "...", "idNumber": "..."}`;

function titleCase(s: string): string {
  if (!s) return s;
  const alpha = s.replace(/[^a-zA-Z]/g, '');
  if (!alpha) return s;
  const upperRatio = alpha.replace(/[^A-Z]/g, '').length / alpha.length;
  if (upperRatio < 0.7) return s;
  return s.toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
}

function parseResponse(raw: string): { name: string; idNumber: string } {
  const stripped = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
  const parsed = JSON.parse(stripped) as Record<string, unknown>;
  const surname    = typeof parsed.surname    === 'string' ? parsed.surname.trim()    : '';
  const givenNames = typeof parsed.givenNames === 'string' ? parsed.givenNames.trim() : '';
  const legacyName = typeof parsed.name       === 'string' ? parsed.name.trim()       : '';
  const composed   = [surname, givenNames].filter(Boolean).join(' ') || legacyName;
  return {
    name:     titleCase(composed),
    idNumber: typeof parsed.idNumber === 'string' ? parsed.idNumber.trim() : '',
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  if (!(await checkAiRateLimit(req, companyId, 'onboarding-extract-id', { companyMax: 30, dailyMax: 300 }))) {
    return apiResponse.tooManyRequests(res, 'AI request limit reached. Please slow down and try again later.');
  }

  const { image } = req.body as { image?: unknown };
  // Pentest M15: ID docs are always images — restrict to JPEG/PNG/WebP.
  if (typeof image !== 'string' || !/^data:image\/(jpeg|png|webp);base64,/.test(image)) {
    return apiResponse.badRequest(res, 'image must be a base64 JPEG, PNG, or WebP data URL');
  }

  log.info('ID extract request', { size: image.length }, 'onboarding/extract-id');

  // Convert PDF to image if needed
  let imageForVlm = image;
  if (image.startsWith('data:application/pdf')) {
    try {
      imageForVlm = await pdfToImage(image);
    } catch (err) {
      log.error('PDF conversion failed', { err }, 'onboarding/extract-id');
      return apiResponse.error(res, 'SERVICE_UNAVAILABLE' as never, 'Could not process PDF.');
    }
  }

  const vlmConfig = getVlmConfig();
  if (!vlmConfig) {
    log.error('VLM not configured (VLLM_BASE_URL missing)', {}, 'onboarding/extract-id');
    return apiResponse.error(res, 'SERVICE_UNAVAILABLE' as never, 'AI extraction unavailable.');
  }

  const userContent: Array<Record<string, unknown>> = [
    { type: 'text', text: USER_PROMPT },
    { type: 'image_url', image_url: { url: imageForVlm } },
  ];

  const text = await callVlmChat(vlmConfig, SYSTEM_PROMPT, userContent, 500);
  if (!text) {
    return apiResponse.error(res, 'SERVICE_UNAVAILABLE' as never, 'AI extraction unavailable.');
  }

  let extracted: { name: string; idNumber: string };
  try {
    extracted = parseResponse(text);
  } catch (err) {
    log.error('ID extract parse error', { err, text }, 'onboarding/extract-id');
    return apiResponse.badRequest(res, 'AI extraction returned an unexpected format.');
  }
  log.info('ID extract success', { name: extracted.name }, 'onboarding/extract-id');
  return apiResponse.success(res, extracted);
}

 
export default withAuth(withErrorHandler(handler));
