/**
 * What onboarding accepts as an upload, shared by the wizard (file pickers, the
 * pre-submit size check) and POST /api/onboarding/complete-setup (which
 * enforces it: onboardingSetupPayload.ts). Client-safe: no Node APIs.
 */

/** Document and ID uploads: what company_documents / company_directors store. */
export const ALLOWED_UPLOAD_MIMES: readonly string[] = ['application/pdf', 'image/jpeg', 'image/png', 'image/gif'];
export const UPLOAD_ACCEPT = ALLOWED_UPLOAD_MIMES.join(',');
/** The owner ID Smart Setup reads: what extract-id reads AND complete-setup stores. */
export const OWNER_ID_ACCEPT = 'image/jpeg,image/png';

/** A real certificate or ID scan is never this small; a 4-byte "%PDF" is not proof. */
export const MIN_UPLOAD_BYTES = 1024;
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** Every file in one request together (documents, ID documents, logo), decoded. */
export const MAX_TOTAL_UPLOAD_BYTES = 30 * 1024 * 1024;

/** Same rules as /api/accounting/company-logo: a raster data URL, under ~5 MB. */
export const LOGO_DATA_URL_RE = /^data:(image\/(?:jpeg|png|gif|webp));base64,[A-Za-z0-9+/=\s]+$/;
export const MAX_LOGO_DATA_URL_CHARS = 6_800_000;

/** Longest accepted text value (names, addresses, numbers); the logo is capped separately. */
export const MAX_TEXT_CHARS = 500;

export const TOTAL_TOO_LARGE = 'The uploaded files are larger than 30 MB together. Remove or shrink some and try again.';

/** Decoded size of a base64 data URL (or bare base64), without decoding it. */
export function decodedBytes(dataUrl: string): number {
  const b64 = dataUrl.startsWith('data:') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
  const clean = b64.replace(/\s/g, '');
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}
