/**
 * PRD-06 Phase 5 follow-up — inbound-email → dunning_sends.response_action bridge.
 *
 * Accepts a generic inbound-email payload (any provider that can POST JSON
 * will work — SendGrid Inbound Parse, Mailgun Routes, Postmark, Zapier). The
 * outbound dunning body contains `[ref:TOKEN]` — we extract the UUID and
 * attempt to infer the response_action from subject/body keywords. Falls
 * back to 'silent' only if the customer's reply offers no signal.
 *
 * Security: the token itself is unguessable. If DUNNING_WEBHOOK_SECRET is
 * configured, the endpoint also enforces an X-Webhook-Secret header.
 */

import { log } from '@/lib/logger';
import { recordResponse } from './dunningAdmin';
import type { ResponseAction } from './dunningService';

const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const REF_TOKEN_RE = /\[ref:([0-9a-f-]+)\]/i;

export interface InboundEmailPayload {
  from?: string;
  subject?: string;
  body_plain?: string;
  body_html?: string;
  /** Raw combined text when the caller doesn't split plain/html. */
  text?: string;
  /** Optional shortcut: forwarded headers (unused today). */
  headers?: Record<string, string>;
}

export interface InboundParseResult {
  matched: boolean;
  messageToken: string | null;
  inferredAction: ResponseAction | null;
  updated: boolean;
  sendId: string | null;
  reason: string;
}

/**
 * Pull the message token out of a reply body. Prefers the explicit `[ref:UUID]`
 * marker (always added by sendDunning); falls back to any bare UUID in the
 * body so a customer's reply-all that quotes the original still matches.
 */
export function extractMessageToken(payload: InboundEmailPayload): string | null {
  const haystacks = [
    payload.body_plain ?? '',
    payload.text ?? '',
    payload.body_html ?? '',
    payload.subject ?? '',
  ];
  for (const text of haystacks) {
    const refMatch = text.match(REF_TOKEN_RE);
    if (refMatch && UUID_RE.test(refMatch[1] ?? '')) return refMatch[1]!.toLowerCase();
  }
  for (const text of haystacks) {
    const bareMatch = text.match(UUID_RE);
    if (bareMatch) return bareMatch[0].toLowerCase();
  }
  return null;
}

const PAID_KEYWORDS = [
  'paid', 'payment made', 'eft done', 'transferred', 'settled',
  'proof of payment', 'pop attached',
];
const PROMISED_KEYWORDS = [
  'will pay', 'next week', 'end of month', 'month-end', 'eom',
  'apologies', 'delayed', 'cash flow', 'by friday', 'by monday',
  'arranging payment', 'payment arrangement',
];
const DISPUTED_KEYWORDS = [
  'dispute', 'disputed', 'incorrect', 'wrong amount', 'not received',
  'never ordered', 'query', 'queried', 'refund', 'cancel',
  'already paid', 'double charged',
];

/**
 * Infer the response_action from subject + body text. "already paid" is
 * treated as DISPUTED (the customer is contesting the outstanding balance)
 * rather than PAID — PAID means "I've just paid / I will pay now".
 * Returns null if no signal matches → caller should default to 'silent'.
 */
export function inferAction(payload: InboundEmailPayload): ResponseAction | null {
  const haystack = [
    payload.subject ?? '',
    payload.body_plain ?? '',
    payload.text ?? '',
  ]
    .join(' \n ')
    .toLowerCase();

  if (DISPUTED_KEYWORDS.some((kw) => haystack.includes(kw))) return 'disputed';
  if (PROMISED_KEYWORDS.some((kw) => haystack.includes(kw))) return 'promised';
  if (PAID_KEYWORDS.some((kw) => haystack.includes(kw))) return 'paid';
  return null;
}

/**
 * End-to-end: pull token from payload, infer action, call recordResponse.
 * Never throws — returns a structured result so the webhook handler can log
 * provider-agnostically.
 */
export async function processInboundEmail(
  payload: InboundEmailPayload,
): Promise<InboundParseResult> {
  const messageToken = extractMessageToken(payload);
  if (!messageToken) {
    return {
      matched: false,
      messageToken: null,
      inferredAction: null,
      updated: false,
      sendId: null,
      reason: 'no message token found in body',
    };
  }

  const inferredAction = inferAction(payload);
  const action: ResponseAction = inferredAction ?? 'silent';

  const note = buildNote(payload);
  const result = await recordResponse(messageToken, action, note);

  log.info('Dunning inbound email processed', {
    messageToken, inferredAction, updated: result.updated, sendId: result.sendId,
  }, 'dunningInbound');

  return {
    matched: true,
    messageToken,
    inferredAction,
    updated: result.updated,
    sendId: result.sendId,
    reason: result.updated
      ? `recorded action=${action}`
      : 'token not found, or response already recorded',
  };
}

function buildNote(payload: InboundEmailPayload): string | null {
  const from = payload.from ?? '';
  const subject = payload.subject ?? '';
  const body = (payload.body_plain ?? payload.text ?? '').trim();
  if (!from && !subject && !body) return null;
  const snippet = body.slice(0, 500);
  const header = [from && `from=${from}`, subject && `subject="${subject}"`]
    .filter(Boolean)
    .join(' ');
  return [header, snippet].filter(Boolean).join('\n---\n').slice(0, 1000);
}
