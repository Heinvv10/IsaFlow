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

export function scrubEvent<T extends Event>(event: T | null): T | null {
  if (!event) return null;

  // A share link's token travels in the URL, not in a keyed field, so the
  // key-based redaction above never sees it — every URL-bearing field on the
  // event needs its own pass through redactShareToken.
  if (typeof event.transaction === 'string') {
    event.transaction = redactShareToken(event.transaction);
  }
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((crumb) => {
      const url = crumb.data?.url;
      if (typeof url !== 'string') return crumb;
      return { ...crumb, data: { ...crumb.data, url: redactShareToken(url) } };
    });
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
