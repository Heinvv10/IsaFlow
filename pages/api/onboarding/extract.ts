/**
 * POST /api/onboarding/extract
 * Accepts a base64 document image and calls the local Qwen3 VLM to
 * extract company registration details.
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

// ── VLM config ────────────────────────────────────────────────────────────────

const VLM_BASE_URL  = process.env.VLLM_BASE_URL  ?? 'http://localhost:8100/v1';
const VLM_MODEL     = process.env.VLLM_MODEL      ?? 'Qwen/Qwen3-VL-8B-Instruct';
const VLM_API_KEY   = process.env.VLLM_API_KEY    ?? 'EMPTY';
const VLM_TIMEOUT   = parseInt(process.env.VLLM_TIMEOUT ?? '120000', 10);

const SYSTEM_PROMPT = `You are a document data extraction assistant specialised in South African business \
documents (CIPC certificates, letterheads, company registrations, VAT certificates). \
Extract structured company information from the provided document image and return ONLY a valid \
JSON object — no markdown, no prose, no explanation. \
If a field cannot be found, return an empty string for that field. \

IMPORTANT field definitions: \
- "name": The official REGISTERED NAME of the company exactly as it appears on the CIPC certificate \
  (e.g. "BRIGHTSPHERE TECHNOLOGIES (PTY) LTD"). This is the legal entity name, NOT the trading name. \
  On CIPC certificates this is labelled "Registered Name" or "Enterprise Name". \
- "tradingName": The trading name or brand name if different from the registered name. \
  On CIPC certificates this may appear as "Trading Name" or "Business Name". \

Return the JSON object with exactly these keys: \
name, tradingName, registrationNumber, vatNumber, taxNumber, \
addressLine1, addressLine2, city, province, postalCode, country, \
phone, email, website, directors. \
The "directors" field must be an array of objects with keys: name, idNumber, role. \
Extract all directors/members listed on the document. If none are listed, return an empty array.`;

const USER_PROMPT = `Extract all company details from this document. \
CRITICAL: The "name" field must be the official REGISTERED NAME (legal entity name) as shown on the document, \
not the trading name. Look for labels like "Registered Name", "Enterprise Name", or "Company Name". \
Also extract: trading name, CIPC registration number (e.g. 2005/023519/07), VAT number, \
income tax reference number, physical/postal address, phone, email, website, \
and all listed directors or members with their full names, ID/passport numbers, and roles (Director, Member, etc). \
Respond with only the JSON object.`;

// ── Extracted data type ───────────────────────────────────────────────────────

interface ExtractedDirector {
  name: string;
  idNumber: string;
  role: string;
}

interface ExtractedCompany {
  name: string;
  tradingName: string;
  registrationNumber: string;
  vatNumber: string;
  taxNumber: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  province: string;
  postalCode: string;
  country: string;
  phone: string;
  email: string;
  website: string;
  directors: ExtractedDirector[];
}

function parseVlmJson(raw: string): ExtractedCompany {
  // Strip ```json ... ``` fences if present
  const stripped = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  const parsed: unknown = JSON.parse(stripped);

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('VLM returned non-object JSON');
  }

  const obj = parsed as Record<string, unknown>;

  const str = (key: string): string =>
    typeof obj[key] === 'string' ? (obj[key] as string) : '';

  /**
   * Normalize ALL-CAPS text to Title Case.
   * Preserves: (Pty) Ltd, (PTY) LTD → (Pty) Ltd, CC, NPC, Inc
   * Only transforms if the string is predominantly uppercase.
   */
  const titleCase = (s: string): string => {
    if (!s) return s;
    const alphaChars = s.replace(/[^a-zA-Z]/g, '');
    if (!alphaChars) return s;
    const upperRatio = alphaChars.replace(/[^A-Z]/g, '').length / alphaChars.length;
    if (upperRatio < 0.7) return s; // already mixed case — leave it

    const KEEP_UPPER = new Set(['pty', 'ltd', 'cc', 'npc', 'inc', 'llc', 'bv', 'sa']);
    return s
      .split(/(\s+|[()]+)/)
      .map(word => {
        const lower = word.toLowerCase();
        if (KEEP_UPPER.has(lower)) return word.charAt(0).toUpperCase() + lower.slice(1);
        if (/^\s+$/.test(word) || /^[()]+$/.test(word)) return word;
        return lower.replace(/^\w/, c => c.toUpperCase());
      })
      .join('');
  };

  return {
    name:               titleCase(str('name')),
    tradingName:        titleCase(str('tradingName')),
    registrationNumber: str('registrationNumber'),
    vatNumber:          str('vatNumber'),
    taxNumber:          str('taxNumber'),
    addressLine1:       titleCase(str('addressLine1')),
    addressLine2:       titleCase(str('addressLine2')),
    city:               titleCase(str('city')),
    province:           titleCase(str('province')),
    postalCode:         str('postalCode'),
    country:            str('country') || 'South Africa',
    phone:              str('phone'),
    email:              str('email'),
    website:            str('website'),
    directors:          parseDirectors(obj.directors, titleCase),
  };
}

function parseDirectors(
  raw: unknown,
  titleCase: (s: string) => string,
): ExtractedDirector[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
    .map(d => ({
      name:     titleCase(typeof d.name === 'string' ? d.name : ''),
      idNumber: typeof d.idNumber === 'string' ? d.idNumber : '',
      role:     titleCase(typeof d.role === 'string' ? d.role : 'Director'),
    }))
    .filter(d => d.name.length > 0);
}

// ── Handler ───────────────────────────────────────────────────────────────────

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  }

  const { image } = req.body as { image?: unknown };

  if (typeof image !== 'string' || !image.startsWith('data:')) {
    return apiResponse.badRequest(res, 'image must be a base64 data URL string');
  }

  log.info('VLM extract request received', { size: image.length }, 'onboarding/extract');

  // ── PDF → PNG conversion ──────────────────────────────────────────────────
  let imageForVlm: string = image;

  if (image.startsWith('data:application/pdf')) {
    log.info('PDF detected — converting first page to PNG', {}, 'onboarding/extract');
    try {
      imageForVlm = await pdfToImage(image);
      log.info('PDF converted to PNG', { size: imageForVlm.length }, 'onboarding/extract');
    } catch (pdfErr: unknown) {
      const msg = pdfErr instanceof Error ? pdfErr.message : String(pdfErr);
      log.error('PDF conversion failed', { msg }, 'onboarding/extract');
      return apiResponse.error(
        res,
        'SERVICE_UNAVAILABLE' as never,
        'Could not convert the PDF for AI extraction. Please try a JPEG or PNG instead.',
      );
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VLM_TIMEOUT);

  let vlmText: string;

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
          {
            role: 'user',
            content: [
              { type: 'text',      text: USER_PROMPT },
              { type: 'image_url', image_url: { url: imageForVlm } },
            ],
          },
        ],
        max_tokens: 2000,
        temperature: 0.1,
      }),
    });

    clearTimeout(timer);

    if (!vlmRes.ok) {
      const body = await vlmRes.text();
      log.error('VLM request failed', { status: vlmRes.status, body }, 'onboarding/extract');
      return apiResponse.error(
        res,
        'SERVICE_UNAVAILABLE' as never,
        'AI extraction is currently unavailable. Please enter details manually.',
      );
    }

    const vlmBody = await vlmRes.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };

    vlmText = vlmBody.choices?.[0]?.message?.content ?? '';

    if (!vlmText) {
      return apiResponse.badRequest(res, 'VLM returned an empty response');
    }
  } catch (err: unknown) {
    clearTimeout(timer);
    const isAbort = err instanceof Error && err.name === 'AbortError';
    log.error('VLM fetch error', { err }, 'onboarding/extract');
    return apiResponse.error(
      res,
      'SERVICE_UNAVAILABLE' as never,
      isAbort
        ? 'AI extraction timed out. Please try again or enter details manually.'
        : 'AI extraction is currently unavailable. Please enter details manually.',
    );
  }

  let extracted: ExtractedCompany;
  try {
    extracted = parseVlmJson(vlmText);
  } catch (parseErr) {
    log.error('VLM JSON parse error', { vlmText, parseErr }, 'onboarding/extract');
    return apiResponse.badRequest(
      res,
      'AI extraction returned an unexpected format. Please enter details manually.',
    );
  }

  log.info('VLM extract success', { name: extracted.name }, 'onboarding/extract');
  return apiResponse.success(res, extracted);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler as any));
