// src/lib/sentry/scrub.ts
import type { Event } from '@sentry/nextjs';
import { REDACTED, redactQueryValues, redactUrlsInText, scrubText, scrubUrl } from './scrubText';

const SENSITIVE_KEY_RE = /pass|token|secret|otp|bank|iban|account.*number/i;
const DROP_HEADERS = new Set(['cookie', 'authorization', 'x-csrf-token']);

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

type Crumb = NonNullable<Event['breadcrumbs']>[number];

function scrubBreadcrumb(input: Crumb): Crumb {
  const console_ = input.category === 'console';
  let crumb = input;
  if (typeof crumb.message === 'string') {
    // console messages are whatever the app logged; every other message loses URL values and any selector it carries.
    const message = console_ ? REDACTED : scrubText(crumb.message);
    if (message !== crumb.message) crumb = { ...crumb, message };
  }
  if (crumb.data) {
    const data: Record<string, unknown> = { ...crumb.data };
    if (console_) delete data.arguments;
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'string') continue;
      data[key] = key === 'url' || key === 'from' || key === 'to' ? scrubUrl(value) : redactUrlsInText(value);
    }
    crumb = { ...crumb, data };
  }
  return crumb;
}

/** Copy of `input` with every string run through `fn`; a cycle becomes '[CIRCULAR]'. */
function mapStrings(input: unknown, fn: (s: string) => string, visited: WeakSet<object> = new WeakSet()): unknown {
  if (typeof input === 'string') return fn(input);
  if (!input || typeof input !== 'object') return input;
  if (visited.has(input)) return '[CIRCULAR]';
  visited.add(input);
  if (Array.isArray(input)) return input.map((item) => mapStrings(item, fn, visited));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) out[k] = mapStrings(v, fn, visited);
  return out;
}

function scrubQueryString(qs: NonNullable<NonNullable<Event['request']>['query_string']>) {
  if (typeof qs === 'string') return redactQueryValues(qs);
  if (Array.isArray(qs)) return qs.map(([k]): [string, string] => [k, REDACTED]);
  return Object.fromEntries(Object.keys(qs).map((k) => [k, REDACTED]));
}

export function scrubEvent<T extends Event>(event: T | null): T | null {
  if (!event) return null;

  // A share link's token travels in the URL, not in a keyed field, so the
  // key-based redaction above never sees it — every URL-bearing field on the
  // event needs its own pass through scrubUrl (share token, query values, fragment).
  if (typeof event.transaction === 'string') {
    event.transaction = scrubUrl(event.transaction);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map(scrubBreadcrumb);
  }
  // Free text: exception text stays, with URL values and selector attributes gone from it.
  if (typeof event.message === 'string') event.message = scrubText(event.message);
  if (event.logentry) event.logentry = mapStrings(event.logentry, scrubText) as typeof event.logentry;
  for (const ex of event.exception?.values ?? []) {
    if (typeof ex.value === 'string') ex.value = scrubText(ex.value);
  }
  if (event.extra) event.extra = mapStrings(event.extra, redactUrlsInText) as typeof event.extra;
  if (event.contexts) event.contexts = mapStrings(event.contexts, redactUrlsInText) as typeof event.contexts;

  const req = event.request;
  if (!req) return event;

  if (typeof req.url === 'string') {
    req.url = scrubUrl(req.url);
  }

  // Drop sensitive headers
  if (req.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers as Record<string, string>)) {
      if (DROP_HEADERS.has(k.toLowerCase())) continue;
      // the page the request came from carries its query (search text, amounts)
      headers[k] = /^referr?er$/i.test(k) && typeof v === 'string' ? scrubUrl(v) : v;
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

  // Redact query string: every value, whatever its key
  if (req.query_string) {
    req.query_string = scrubQueryString(req.query_string);
  }

  return event;
}
