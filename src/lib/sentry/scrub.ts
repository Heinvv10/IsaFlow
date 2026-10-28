// src/lib/sentry/scrub.ts
import type { Event } from '@sentry/nextjs';
import { redactShareToken } from '@/lib/observability/redactShareToken';

const SENSITIVE_KEY_RE = /pass|token|secret|otp|bank|iban|account.*number/i;
const DROP_HEADERS = new Set(['cookie', 'authorization', 'x-csrf-token']);
const REDACTED = '[REDACTED]';

function redactObject(input: unknown, visited: WeakSet<object> = new WeakSet()): unknown {
  if (!input || typeof input !== 'object') return input;
  if (visited.has(input as object)) return '[CIRCULAR]';
  visited.add(input as object);
  if (Array.isArray(input)) return input.map((item) => redactObject(item, visited));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else if (v && typeof v === 'object') {
      out[k] = redactObject(v, visited);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function redactQueryString(qs: string): string {
  return qs
    .split('&')
    .map((pair) => {
      const eq = pair.indexOf('=');
      if (eq === -1) return pair;
      const rawKey = pair.slice(0, eq);
      let decodedKey: string;
      try {
        decodedKey = decodeURIComponent(rawKey);
      } catch {
        decodedKey = rawKey;
      }
      return SENSITIVE_KEY_RE.test(decodedKey) ? `${rawKey}=${REDACTED}` : pair;
    })
    .join('&');
}

// FNV-1a 32-bit — portable across Node + edge runtimes (no `crypto` import).
// Not cryptographic; used only to obfuscate PII in Sentry payloads deterministically.
function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function hashEmailLocalPart(email: string): string {
  const at = email.indexOf('@');
  if (at === -1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const h = fnv1aHex(local);
  return `${h}${domain}`;
}

// Sentry's ui.click / ui.input breadcrumbs describe the element as a selector (@sentry/core _htmlElementAsString):
// `tag#id.class` then `[aria-label="…"][type="…"][name="…"][title="…"][alt="…"]`, plus whatever `serializeAttribute`
// names. Values are written UNESCAPED, so a value may hold `"]` or ` > ` and its end cannot be found by looking for
// the first `"]`. Grid controls are named after their row (date, payee, amount) and a note's title is the note, so
// every attribute value is customer data. The selector stays for debugging; each `[attr="value"]` keeps its name and
// loses its value. A value runs to the next safe `[type="…"]` or the next element (` > ` then a tag name), else to
// the end of the string: what follows a value that holds `"]` is part of that value, so the run swallows it.
const SAFE_TYPE = '\\[type="(?:checkbox|radio|button|submit|reset|text|number|date|search|email|tel|url|file)"\\]';
const SAFE_TYPE_RE = new RegExp(SAFE_TYPE, 'y');
const RUN_END_RE = new RegExp(`${SAFE_TYPE}| > (?=[a-z][a-z0-9-]*(?:[.#[]| > |$))`, 'gi');
const ATTR_START_RE = /\[([A-Za-z_:][\w:.-]*)="/y;

function redactDomAttrs(selector: string): string {
  let out = '';
  let i = 0;
  while (i < selector.length) {
    const open = selector.indexOf('[', i);
    if (open === -1) return out + selector.slice(i);
    out += selector.slice(i, open);
    SAFE_TYPE_RE.lastIndex = open;
    const safe = SAFE_TYPE_RE.exec(selector);
    if (safe) { out += safe[0]; i = open + safe[0].length; continue; }
    ATTR_START_RE.lastIndex = open;
    const attr = ATTR_START_RE.exec(selector);
    if (!attr) { out += '['; i = open + 1; continue; }
    RUN_END_RE.lastIndex = open + attr[0].length;
    const end = RUN_END_RE.exec(selector);
    out += `[${attr[1]}="${REDACTED}"]`;
    i = end ? end.index : selector.length;
  }
  return out;
}

// Keep a URL's path and parameter NAMES, drop the values: the bank transactions list puts search text and amounts
// in its query. A value redactShareToken already masked stays `[token]`.
function redactUrlQueryValues(url: string): string {
  const q = url.indexOf('?');
  if (q === -1) return url;
  const hash = url.indexOf('#', q);
  const end = hash === -1 ? url.length : hash;
  const query = url.slice(q + 1, end).split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq === -1 || pair.slice(eq + 1) === '[token]') return pair;
    return `${pair.slice(0, eq)}=${REDACTED}`;
  }).join('&');
  return `${url.slice(0, q + 1)}${query}${url.slice(end)}`;
}

function scrubUrl(url: string): string {
  return redactUrlQueryValues(redactShareToken(url));
}

type Crumb = NonNullable<Event['breadcrumbs']>[number];

function scrubBreadcrumb(input: Crumb): Crumb {
  let crumb = input;
  if (typeof crumb.message === 'string') {
    // console messages are whatever the app logged; every other message is scrubbed for a selector it carries.
    const message = crumb.category === 'console' ? REDACTED : redactDomAttrs(crumb.message);
    if (message !== crumb.message) crumb = { ...crumb, message };
  }
  if (crumb.data) {
    const data: Record<string, unknown> = { ...crumb.data };
    if (crumb.category === 'console') delete data.arguments;
    for (const key of ['url', 'from', 'to']) {
      const value = data[key];
      if (typeof value === 'string') data[key] = scrubUrl(value);
    }
    crumb = { ...crumb, data };
  }
  return crumb;
}

export function scrubEvent<T extends Event>(event: T | null): T | null {
  if (!event) return null;

  // A share link's token travels in the URL, not in a keyed field, so the
  // key-based redaction above never sees it — every URL-bearing field on the
  // event needs its own pass through redactShareToken.
  if (typeof event.transaction === 'string') {
    event.transaction = redactShareToken(event.transaction);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }

  const req = event.request;
  if (!req) return event;

  if (typeof req.url === 'string') {
    req.url = redactShareToken(req.url);
  }

  // Drop sensitive headers
  if (req.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers as Record<string, string>)) {
      if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    req.headers = headers;
  }

  // Redact body — always hash the local-part of request.data.email per spec.
  if (req.data && typeof req.data === 'object') {
    const data = redactObject(req.data) as Record<string, unknown>;
    if (typeof data.email === 'string') {
      data.email = hashEmailLocalPart(data.email);
    }
    req.data = data;
  }

  // Redact query string
  if (typeof req.query_string === 'string') {
    req.query_string = redactQueryString(req.query_string);
  }

  return event;
}
