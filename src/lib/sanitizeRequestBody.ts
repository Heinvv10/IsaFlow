/**
 * The request-body scrubber for error logs (api-error-handler). Credentials and
 * bank account numbers are redacted; uploaded files and ID numbers are replaced by a size marker at any
 * depth, so a logged body never carries a certificate, an ID scan or an ID
 * number (onboarding complete-setup, company-directors, company-documents). Size
 * is bounded at every level: an array of more than MAX_LOGGED_ITEMS is logged as
 * its item count, an object of more than MAX_LOGGED_KEYS as its key count, and a
 * string over LONG_STRING as its length, so a bulk body (a 20 000-cell budget
 * save, ~3.4 MB, or a 14 MB base64 upload) is never written to the request log
 * whole. Only a JSON object can be read for what it holds, so loggableRequestBody
 * logs nothing else: text, form-encoded bodies (whose keys may be the data) and
 * anything without a JSON content type are omitted outright. In a JSON object, a
 * key that may itself be data (over 64 characters, or holding six or more digits
 * in a row, the shortest account number) is left out and counted. loggableUrl
 * gives a query string the same checks, so a key or number moved to the URL
 * fares no better.
 */

const SENSITIVE_KEYS = new Set([
  'password', 'confirmPassword', 'password_hash', 'token', 'secret', 'apiKey', 'api_key',
  // OAuth token-endpoint credentials — exact-key matching missed these, so
  // /api/oauth/token was logging raw refresh tokens + client secrets to stdout.
  'client_secret', 'clientSecret', 'refresh_token', 'refreshToken',
  'access_token', 'accessToken', 'code_verifier', 'codeVerifier',
  // Every non-GET body reaches journald: employee and supplier bank account numbers stay out of it.
  'accountNumber', 'account_number', 'bankAccountNumber', 'bank_account_number',
]);

// Substring fragments — redact any key containing these, so new/renamed
// credential fields (…_secret, …_token, …verifier) can't silently leak. Written
// normalised (see normaliseKey). Kept narrow to avoid over-redacting benign
// fields ('code' alone, a single-use auth code, is intentionally NOT a fragment
// — too broad; 'accountno' would also match account_notes: see ACCOUNT_NUMBER_KEY).
const SENSITIVE_FRAGMENTS = ['secret', 'token', 'password', 'apikey', 'verifier', 'accountnumber'];

/** A client's spelling of a field does not matter: AccountNumber, account.number and `account number` are one key. */
const normaliseKey = (key: string) => key.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
const NORMALISED_SENSITIVE_KEYS = new Set([...SENSITIVE_KEYS].map(normaliseKey));

/** acc_no, employee_account_no, bankAccNo, accountnr: whole words, so account_notes and accountNotes stay. */
const ACCOUNT_NUMBER_KEY = /(?:^|[^a-z0-9])(?:acc|acct|account)[^a-z0-9]*(?:no|nr|num|number)(?:$|[^a-z0-9])/;
const separateWords = (key: string) => key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();

function isSensitiveKey(key: string): boolean {
  const k = normaliseKey(key);
  return NORMALISED_SENSITIVE_KEYS.has(k) || SENSITIVE_FRAGMENTS.some((f) => k.includes(f))
    || ACCOUNT_NUMBER_KEY.test(separateWords(key));
}

/** A key too long to be a field name, or with an account number's run of digits in it, even split up, may be the data itself. */
const MAX_LOGGED_KEY_LENGTH = 64;
export const keyMayBeData = (key: string) => key.length > MAX_LOGGED_KEY_LENGTH || /\p{Nd}{6}/u.test(normaliseKey(key));

/** Always a file or an ID number, whatever the value looks like. */
const PAYLOAD_KEYS = new Set(['file_data', 'fileData', 'idDocument', 'logoData', 'idNumber', 'id_number']);
const NORMALISED_PAYLOAD_KEYS = new Set([...PAYLOAD_KEYS].map(normaliseKey));
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
    if (keyMayBeData(key)) omittedKeys += 1;
    else if (isSensitiveKey(key)) sanitized[key] = '[REDACTED]';
    else if (NORMALISED_PAYLOAD_KEYS.has(normaliseKey(key)) && present(value)) sanitized[key] = omitted(value);
    else if (key === 'data' && holdsFiles(value)) sanitized[key] = omitted(value);
    else sanitized[key] = sanitizeRequestBody(value, depth + 1);
  }
  if (omittedKeys > 0) sanitized['[omitted keys]'] = omittedKeys;
  return sanitized;
}

/**
 * What the request log may hold of a body: a JSON object, scrubbed, or that something else was sent.
 * `fields`: a route whose every body holds credentials names what may be logged, in JSON or form-encoded.
 */
export function loggableRequestBody(
  req: { headers: Record<string, string | string[] | undefined>; body?: unknown }, fields?: readonly string[],
): unknown {
  const { body } = req;
  if (!present(body)) return undefined;
  const isObject = typeof body === 'object' && !Array.isArray(body);
  if (fields && isObject) {
    return sanitizeRequestBody(Object.fromEntries(Object.entries(body as object).filter(([key]) => fields.includes(key))));
  }
  const contentType = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  return contentType === 'application/json' && isObject ? sanitizeRequestBody(body) : '[omitted: not a JSON object]';
}

function decodedName(name: string): string {
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '));
  } catch {
    return name; // not valid percent-encoding: judge it as it stands
  }
}

/** A URL for the request log: a parameter whose name may be data goes whole, and a sensitive one loses its value. Masked token values stay. */
export function loggableUrl(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const params = url.slice(q + 1).split('&').map((param) => {
    const eq = param.indexOf('=');
    const name = eq === -1 ? param : param.slice(0, eq);
    const key = decodedName(name);
    if (keyMayBeData(key)) return '[omitted]';
    if (param.endsWith('=[token]')) return param;
    return isSensitiveKey(key) || NORMALISED_PAYLOAD_KEYS.has(normaliseKey(key)) ? `${name}=[REDACTED]` : param;
  });
  return `${url.slice(0, q + 1)}${params.join('&')}`;
}
