/**
 * POST /api/onboarding/extract
 * Accepts a base64 document image and calls the VLM (configured via
 * VLM_MODEL env var) to extract company registration details.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { checkAiRateLimit } from '@/lib/rateLimit';
import { log } from '@/lib/logger';
import { pdfToImages } from '@/lib/pdf-to-image';
import { callVlmChat, getVlmConfig } from '@/modules/accounting/services/bank/vlmCore';
import { normaliseAddressFields } from '@/modules/onboarding/services/addressNormaliser';
import { normaliseRegistrationNumber } from '@/modules/onboarding/services/registrationNumberNormaliser';

export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } },
};

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

ADDRESS PARSING (critical — do NOT dump whole addresses into one line): \
South African addresses typically look like: \
  "57 Parfitt Avenue, Park West, Bloemfontein, 9301" \
  "12 Main Road, Sandton, 2196" \
  "PO Box 1234, Cape Town, 8000" \
You MUST split these into separate fields: \
- "addressLine1": the street number + street name (e.g. "57 Parfitt Avenue" or "PO Box 1234") \
- "addressLine2": the suburb or area only (e.g. "Park West") — NOT the city or postal code \
- "city": the TOWN / CITY name on its own (e.g. "Bloemfontein", "Sandton", "Cape Town") \
- "postalCode": the 4-digit South African postal code on its own (e.g. "9301", "2196", "8000") \
- "province": if visible, otherwise empty string (we will infer it from the postal code) \
Never put the city, postal code, or province inside addressLine1 or addressLine2. \

Return the JSON object with exactly these keys: \
name, tradingName, registrationNumber, vatNumber, taxNumber, \
addressLine1, addressLine2, city, province, postalCode, country, \
phone, email, website, directors. \
The "directors" field must be an array of objects with keys: name, idNumber, role. \
Extract all directors/members listed on the document. If none are listed, return an empty array. \
\
MULTI-PAGE DOCUMENTS (important for CIPC COR39 and similar): \
The document may be supplied as several images — one per page. Treat them as a single \
document and merge information across pages. For directors specifically, prefer the \
"ACTIVE DIRECTORS/MEMBERS" table (usually on a later page) over any cover-letter \
amendment notice that only mentions the director being changed. Deduplicate directors \
by ID/passport number.`;

const USER_PROMPT = `Extract all company details from this document. \
CRITICAL: The "name" field must be the official REGISTERED NAME (legal entity name) as shown on the document, \
not the trading name. Look for labels like "Registered Name", "Enterprise Name", or "Company Name". \
Also extract: trading name, CIPC registration number (e.g. 2005/023519/07), VAT number, \
income tax reference number, physical/postal address, phone, email, website, \
and all listed directors or members with their full names, ID/passport numbers, and roles (Director, Member, etc). \
\
ADDRESS REMINDER: Split the physical address into street (addressLine1), suburb (addressLine2), \
city, 4-digit postalCode, and province as separate fields. Do NOT concatenate them into one line. \
\
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

  // Let the normaliser split city/postalCode out of line1/line2 when the VLM
  // dumps them together, and infer province from postal code when missing.
  const normalised = normaliseAddressFields({
    addressLine1: titleCase(str('addressLine1')),
    addressLine2: titleCase(str('addressLine2')),
    city:         titleCase(str('city')),
    province:     titleCase(str('province')),
    postalCode:   str('postalCode'),
  });

  return {
    name:               titleCase(str('name')),
    tradingName:        titleCase(str('tradingName')),
    registrationNumber: normaliseRegistrationNumber(str('registrationNumber')),
    vatNumber:          str('vatNumber'),
    taxNumber:          str('taxNumber'),
    addressLine1:       normalised.addressLine1,
    addressLine2:       normalised.addressLine2,
    city:               normalised.city,
    province:           normalised.province,
    postalCode:         normalised.postalCode,
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

  const { companyId } = req as CompanyAuthedRequest;

  if (!(await checkAiRateLimit(req, companyId, 'onboarding-extract', { companyMax: 30, dailyMax: 300 }))) {
    return apiResponse.tooManyRequests(res, 'AI request limit reached. Please slow down and try again later.');
  }

  const { image } = req.body as { image?: unknown };

  // Pentest M15: restrict to image/* and application/pdf. Previous
  // startsWith('data:') accepted data:text/html and data:application/javascript,
  // which then flowed into the VLM pipeline.
  if (typeof image !== 'string' || !/^data:(image\/(jpeg|png|gif|webp)|application\/pdf);base64,/.test(image)) {
    return apiResponse.badRequest(res, 'image must be a base64 image or PDF data URL');
  }

  log.info('VLM extract request received', { size: image.length }, 'onboarding/extract');

  // ── PDF → PNG conversion ──────────────────────────────────────────────────
  // CIPC documents like COR39 often span multiple pages where critical data
  // (e.g. the active directors table) lives past page 1 — render all pages.
  let imagesForVlm: string[] = [image];

  if (image.startsWith('data:application/pdf')) {
    log.info('PDF detected — converting all pages to PNG', {}, 'onboarding/extract');
    try {
      imagesForVlm = await pdfToImages(image);
      log.info(
        'PDF converted to PNGs',
        { pages: imagesForVlm.length },
        'onboarding/extract',
      );
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

  const vlmConfig = getVlmConfig();
  if (!vlmConfig) {
    log.error('VLM not configured (VLLM_BASE_URL missing)', {}, 'onboarding/extract');
    return apiResponse.error(
      res,
      'SERVICE_UNAVAILABLE' as never,
      'AI extraction is currently unavailable. Please enter details manually.',
    );
  }

  const userContent: Array<Record<string, unknown>> = [
    { type: 'text', text: USER_PROMPT },
    ...imagesForVlm.map(url => ({ type: 'image_url' as const, image_url: { url } })),
  ];

  const vlmText = await callVlmChat(vlmConfig, SYSTEM_PROMPT, userContent);
  if (!vlmText) {
    return apiResponse.error(
      res,
      'SERVICE_UNAVAILABLE' as never,
      'AI extraction is currently unavailable. Please enter details manually.',
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

 
export default withAuth(withErrorHandler(withCsrf(handler)));
