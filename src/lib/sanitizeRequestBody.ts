/**
 * The request-body scrubber for error logs (api-error-handler). Credentials are
 * redacted; uploaded files and ID numbers are replaced by a size marker at any
 * depth, so a logged body never carries a certificate, an ID scan or an ID
 * number (onboarding complete-setup, company-directors, company-documents).
 */

const SENSITIVE_KEYS = new Set([
  'password', 'confirmPassword', 'password_hash', 'token', 'secret', 'apiKey', 'api_key',
  // OAuth token-endpoint credentials — exact-key matching missed these, so
  // /api/oauth/token was logging raw refresh tokens + client secrets to stdout.
  'client_secret', 'clientSecret', 'refresh_token', 'refreshToken',
  'access_token', 'accessToken', 'code_verifier', 'codeVerifier',
]);

// Substring fragments — redact any key containing these (case-insensitive), so
// new/renamed credential fields (…_secret, …_token, …verifier) can't silently
// leak. Kept narrow to avoid over-redacting benign fields ('code' alone, a
// single-use auth code, is intentionally NOT a fragment — too broad).
const SENSITIVE_FRAGMENTS = ['secret', 'token', 'password', 'apikey', 'verifier'];

function isSensitiveKey(key: string): boolean {
  if (SENSITIVE_KEYS.has(key)) return true;
  const k = key.toLowerCase();
  return SENSITIVE_FRAGMENTS.some((f) => k.includes(f));
}

/** Always a file or an ID number, whatever the value looks like. */
const PAYLOAD_KEYS = new Set(['file_data', 'fileData', 'idDocument', 'logoData', 'idNumber', 'id_number']);
/** `data` is a common key (bulk rows, settings): omitted only when it is, or holds at any depth, a file (a data: URL or a long string). */
const LONG_STRING = 1024;
const isFileLike = (value: unknown) => typeof value === 'string' && (value.startsWith('data:') || value.length > LONG_STRING);
/** A file anywhere inside the value (nested arrays and objects too). Past the depth cap: assume so (fail closed). */
function holdsFiles(value: unknown, depth = 0): boolean {
  if (isFileLike(value)) return true;
  if (!value || typeof value !== 'object') return false;
  if (depth > 8) return true;
  return Object.values(value as Record<string, unknown>).some((v) => holdsFiles(v, depth + 1));
}
const omitted = (value: unknown) => (typeof value === 'string' ? `[omitted: ${value.length} chars]`
  : Array.isArray(value) ? `[omitted: ${value.length} items]` : '[omitted]');
const present = (value: unknown) => value !== null && value !== undefined && value !== '';

export function sanitizeRequestBody(body: unknown, depth = 0): unknown {
  if (!body || typeof body !== 'object') return body;
  if (depth > 8) return '[omitted: nested too deep]';
  if (Array.isArray(body)) return body.map((v) => sanitizeRequestBody(v, depth + 1));
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (isSensitiveKey(key)) sanitized[key] = '[REDACTED]';
    else if (PAYLOAD_KEYS.has(key) && present(value)) sanitized[key] = omitted(value);
    else if (key === 'data' && holdsFiles(value)) sanitized[key] = omitted(value);
    else sanitized[key] = sanitizeRequestBody(value, depth + 1);
  }
  return sanitized;
}
