/**
 * The request-body scrubber for error logs (api-error-handler). Credentials and
 * bank account numbers are redacted; uploaded files and ID numbers are replaced by a size marker at any
 * depth, so a logged body never carries a certificate, an ID scan or an ID
 * number (onboarding complete-setup, company-directors, company-documents). Size
 * is bounded at every level: an array of more than MAX_LOGGED_ITEMS is logged as
 * its item count, an object of more than MAX_LOGGED_KEYS as its key count, and a
 * string over LONG_STRING as its length, so a bulk body (a 20 000-cell budget
 * save, ~3.4 MB, or a 14 MB base64 upload) is never written to the request log
 * whole. A body that is not JSON cannot be read for what it holds, so it is not
 * logged at all: a top-level string (text/plain) is a size marker, and a key
 * that is not a name (a form-encoded JSON body parses to one key) is counted.
 */

const SENSITIVE_KEYS = new Set([
  'password', 'confirmPassword', 'password_hash', 'token', 'secret', 'apiKey', 'api_key',
  // OAuth token-endpoint credentials — exact-key matching missed these, so
  // /api/oauth/token was logging raw refresh tokens + client secrets to stdout.
  'client_secret', 'clientSecret', 'refresh_token', 'refreshToken',
  'access_token', 'accessToken', 'code_verifier', 'codeVerifier',
  // Every non-GET body reaches journald: employee and supplier bank account numbers stay out of it.
  'accountNumber', 'account_number', 'bankAccountNumber', 'bank_account_number', 'account_no', 'bank_account_no',
]);

// Substring fragments — redact any key containing these, so new/renamed
// credential fields (…_secret, …_token, …verifier) can't silently leak. Written
// normalised (see normaliseKey). Kept narrow to avoid over-redacting benign
// fields ('code' alone, a single-use auth code, is intentionally NOT a fragment
// — too broad; 'accountno' would also match account_notes).
const SENSITIVE_FRAGMENTS = ['secret', 'token', 'password', 'apikey', 'verifier', 'accountnumber'];

/** A client's spelling of a field does not matter: AccountNumber, account-number and account_number are one key. */
const normaliseKey = (key: string) => key.toLowerCase().replace(/[_-]/g, '');
const NORMALISED_SENSITIVE_KEYS = new Set([...SENSITIVE_KEYS].map(normaliseKey));

function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  return NORMALISED_SENSITIVE_KEYS.has(k) || SENSITIVE_FRAGMENTS.some((f) => k.includes(f));
}

/** A key is logged only if it reads as a field name, up to 64 characters: anything else may be the data itself. */
const LOGGABLE_KEY = /^[\p{L}\p{N}_$. -]{1,64}$/u;

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
/** Wider objects are logged as `[omitted: N keys]`. */
const MAX_LOGGED_KEYS = 200;
const present = (value: unknown) => value !== null && value !== undefined && value !== '';
/** Longer arrays are logged as `[omitted: N items]`. */
const MAX_LOGGED_ITEMS = 50;

export function sanitizeRequestBody(body: unknown, depth = 0): unknown {
  // Any long string, under any key: a 14 MB value would otherwise be logged and kept in the logger's buffer.
  if (typeof body === 'string') return depth === 0 || body.length > LONG_STRING ? omitted(body) : body;
  if (!body || typeof body !== 'object') return body;
  if (depth > 8) return '[omitted: nested too deep]';
  if (Array.isArray(body)) return body.length > MAX_LOGGED_ITEMS ? omitted(body) : body.map((v) => sanitizeRequestBody(v, depth + 1));
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length > MAX_LOGGED_KEYS) return `[omitted: ${entries.length} keys]`;
  const sanitized: Record<string, unknown> = {};
  let omittedKeys = 0;
  for (const [key, value] of entries) {
    if (!LOGGABLE_KEY.test(key)) omittedKeys += 1;
    else if (isSensitiveKey(key)) sanitized[key] = '[REDACTED]';
    else if (PAYLOAD_KEYS.has(key) && present(value)) sanitized[key] = omitted(value);
    else if (key === 'data' && holdsFiles(value)) sanitized[key] = omitted(value);
    else sanitized[key] = sanitizeRequestBody(value, depth + 1);
  }
  if (omittedKeys > 0) sanitized['[omitted keys]'] = omittedKeys;
  return sanitized;
}
