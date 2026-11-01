/**
 * The request-body scrubber for error logs (api-error-handler). Credentials are
 * redacted; uploaded files, ID and tax numbers, birth dates, medical aid details
 * and salaries are replaced by a marker at any depth, so a logged body never
 * carries a certificate, an ID scan, an ID number (onboarding complete-setup,
 * company-directors, company-documents) or what someone earns next to their
 * name (POST /api/payroll/employees). A route whose body holds pay under a
 * common key (`amount`) names that key: withErrorHandler's maskBodyKeys. Size
 * is bounded at every level: an array of more than MAX_LOGGED_ITEMS is logged as
 * its item count, an object of more than MAX_LOGGED_KEYS as its key count, and a
 * string over LONG_STRING as its length, so a bulk body (a 20 000-cell budget
 * save, ~3.4 MB, or a 14 MB base64 upload) is never written to the request log
 * whole.
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

/** Always a file or a person's identity, health or pay details, whatever the value looks like. */
const PAYLOAD_KEYS = new Set([
  'file_data', 'fileData', 'idDocument', 'logoData', 'idNumber', 'id_number', 'salary',
  'taxNumber', 'tax_number', 'dateOfBirth', 'date_of_birth',
  // Who is on medical aid and how many dependants they cover: POPIA treats health information as special.
  'medicalAidMainMember', 'medical_aid_main_member', 'medicalAidDependantsCount', 'medical_aid_dependants_count',
]);
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
const NO_KEYS: ReadonlySet<string> = new Set();

/** `maskedKeys`: the calling route's own PAYLOAD_KEYS, for a key too common to mask everywhere. */
export function sanitizeRequestBody(body: unknown, depth = 0, maskedKeys: ReadonlySet<string> = NO_KEYS): unknown {
  // Any long string, under any key: a 14 MB value would otherwise be logged and kept in the logger's buffer.
  if (typeof body === 'string') return body.length > LONG_STRING ? omitted(body) : body;
  if (!body || typeof body !== 'object') return body;
  if (depth > 8) return '[omitted: nested too deep]';
  if (Array.isArray(body)) return body.length > MAX_LOGGED_ITEMS ? omitted(body) : body.map((v) => sanitizeRequestBody(v, depth + 1, maskedKeys));
  const entries = Object.entries(body as Record<string, unknown>);
  if (entries.length > MAX_LOGGED_KEYS) return `[omitted: ${entries.length} keys]`;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (isSensitiveKey(key)) sanitized[key] = '[REDACTED]';
    else if ((PAYLOAD_KEYS.has(key) || maskedKeys.has(key)) && present(value)) sanitized[key] = omitted(value);
    else if (key === 'data' && holdsFiles(value)) sanitized[key] = omitted(value);
    else sanitized[key] = sanitizeRequestBody(value, depth + 1, maskedKeys);
  }
  return sanitized;
}
