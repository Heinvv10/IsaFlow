/**
 * POST /api/onboarding/extract-id
 * Extracts director name and ID number from an uploaded ID document / passport
 * using the VLM (configured via VLM_MODEL env var).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';
import { pdfToImage } from '@/lib/pdf-to-image';
import { callVlmChat, getVlmConfig } from '@/modules/accounting/services/bank/vlmCore';

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

const SYSTEM_PROMPT = `You are a document data extraction assistant specialised in South African identity documents \
(ID cards, smart ID cards, passports, driver's licenses). \
Extract the person's full name and identity/passport number from the provided document image. \
Return ONLY a valid JSON object with exactly these keys: name, idNumber. \
If a field cannot be found, return an empty string. No markdown, no prose.`;

const USER_PROMPT = `Extract the full name and ID/passport number from this identity document. \
Respond with only the JSON object: {"name": "...", "idNumber": "..."}`;

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
  return {
    name:     titleCase(typeof parsed.name === 'string' ? parsed.name : ''),
    idNumber: typeof parsed.idNumber === 'string' ? parsed.idNumber : '',
  };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { image } = req.body as { image?: unknown };
  if (typeof image !== 'string' || !image.startsWith('data:')) {
    return apiResponse.badRequest(res, 'image must be a base64 data URL string');
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
