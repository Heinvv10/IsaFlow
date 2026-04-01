/**
 * POST /api/onboarding/extract-id
 * Extracts director name and ID number from an uploaded ID document / passport
 * using the Qwen3 VLM.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth } from '@/lib/auth';
import { log } from '@/lib/logger';
import { pdfToImage } from '@/lib/pdf-to-image';

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

const VLM_BASE_URL = process.env.VLLM_BASE_URL ?? 'http://localhost:8100/v1';
const VLM_MODEL    = process.env.VLLM_MODEL    ?? 'Qwen/Qwen3-VL-8B-Instruct';
const VLM_API_KEY  = process.env.VLLM_API_KEY  ?? 'EMPTY';
const VLM_TIMEOUT  = parseInt(process.env.VLLM_TIMEOUT ?? '120000', 10);

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

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VLM_TIMEOUT);

  try {
    const vlmRes = await fetch(`${VLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${VLM_API_KEY}`,
      },
      body: JSON.stringify({
        model: VLM_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: [
            { type: 'text', text: USER_PROMPT },
            { type: 'image_url', image_url: { url: imageForVlm } },
          ]},
        ],
        max_tokens: 500,
        temperature: 0.1,
      }),
    });

    clearTimeout(timer);

    if (!vlmRes.ok) {
      return apiResponse.error(res, 'SERVICE_UNAVAILABLE' as never, 'AI extraction unavailable.');
    }

    const vlmBody = await vlmRes.json() as { choices?: Array<{ message?: { content?: string } }> };
    const text = vlmBody.choices?.[0]?.message?.content ?? '';

    if (!text) {
      return apiResponse.badRequest(res, 'VLM returned empty response');
    }

    const extracted = parseResponse(text);
    log.info('ID extract success', { name: extracted.name }, 'onboarding/extract-id');
    return apiResponse.success(res, extracted);
  } catch (err) {
    clearTimeout(timer);
    log.error('ID extract error', { err }, 'onboarding/extract-id');
    return apiResponse.error(res, 'SERVICE_UNAVAILABLE' as never, 'AI extraction unavailable.');
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
