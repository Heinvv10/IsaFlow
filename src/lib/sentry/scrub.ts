// src/lib/sentry/scrub.ts
import type { Event } from '@sentry/nextjs';
import { createHash } from 'crypto';

const SENSITIVE_KEY_RE = /pass|token|secret|otp|bank|iban|account.*number/i;
const DROP_HEADERS = new Set(['cookie', 'authorization', 'x-csrf-token']);
const REDACTED = '[REDACTED]';

function redactObject(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map(redactObject);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (SENSITIVE_KEY_RE.test(k)) {
      out[k] = REDACTED;
    } else if (v && typeof v === 'object') {
      out[k] = redactObject(v);
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
      const k = pair.slice(0, eq);
      return SENSITIVE_KEY_RE.test(k) ? `${k}=${encodeURIComponent(REDACTED)}` : pair;
    })
    .join('&');
}

function hashEmailLocalPart(email: string): string {
  const at = email.indexOf('@');
  if (at === -1) return email;
  const local = email.slice(0, at);
  const domain = email.slice(at);
  const h = createHash('sha256').update(local).digest('hex').slice(0, 8);
  return `${h}${domain}`;
}

export function scrubEvent(event: Event | null): Event | null {
  if (!event) return null;
  const req = event.request;
  if (!req) return event;

  // Drop sensitive headers
  if (req.headers) {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers as Record<string, string>)) {
      if (!DROP_HEADERS.has(k.toLowerCase())) headers[k] = v;
    }
    req.headers = headers;
  }

  // Redact body — hash standalone email fields; leave email in context when
  // other fields are present (passwords etc. are already redacted there).
  if (req.data && typeof req.data === 'object') {
    const data = redactObject(req.data) as Record<string, unknown>;
    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0] === 'email' && typeof data.email === 'string') {
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
