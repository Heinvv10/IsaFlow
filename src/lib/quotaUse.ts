/**
 * Usage-quota bookkeeping on the request context (R-175).
 *
 * A usage quota bounds work actually done: AI calls a provider answered,
 * emails a mail server accepted. The limiter charges the quota up front; the
 * place that does the work records that it was done; the request's owner gives
 * back what was charged and not used (`@/lib/rateLimitQuota`).
 *
 * This file is deliberately tiny and depends only on `@/lib/als`, so the
 * shared AI and email clients can import it without pulling in the limiter.
 *
 * Only `withAuth` keeps the list. Anywhere else both functions do nothing and
 * a charge simply stands.
 */

import { als, type QuotaKind } from '@/lib/als';

export type { QuotaKind } from '@/lib/als';

/**
 * Called by the limiter: this request charged `units` of `key`, in the window
 * that began at `windowStart`, refundable if unused.
 */
export function noteQuotaCharge(kind: QuotaKind, key: string, units: number, windowStart: string | null): void {
  als.getStore()?.quotaCharges?.push({ kind, key, charged: units, used: 0, windowStart });
}

/**
 * Called when the request hands work to something that runs after it has
 * ended (`runAfterCommit`). Use recorded there cannot reach the settle, so the
 * request can no longer show that anything was left unused: every noted charge
 * is kept. Fail safe: a deferred send can cost a refund, never grant one.
 */
export function forfeitQuotaRefund(): void {
  for (const charge of als.getStore()?.quotaCharges ?? []) charge.used = Math.max(charge.used, charge.charged);
}

/**
 * Called where the bounded work happens, once it has happened: a provider
 * answered, a mail server accepted a message. Call it at the shared client,
 * not in each route. A route whose work never reaches a call to this must not
 * ask for `refundUnused`, or its quota would always be given back.
 */
export function markQuotaUsed(kind: QuotaKind, units = 1): void {
  // Use can only be added. A zero, negative or NaN count would otherwise turn
  // into a refund the request did not earn.
  if (!(units >= 1)) return;
  for (const charge of als.getStore()?.quotaCharges ?? []) {
    if (charge.kind === kind) charge.used += units;
  }
}

/**
 * Failures that prove a provider call never left this machine: the connection
 * was refused, the name did not resolve, or the connect itself timed out.
 */
const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT']);

/**
 * Called with the HTTP status of a provider answer that was not a success.
 * A 4xx is a refusal of the request itself (bad input, auth, 429 rate limit):
 * no work was done. A 5xx proves nothing: a 502/503/504 can come from a proxy
 * after the provider did the work. A 408 is a timeout. Both count as use.
 */
export function markQuotaUsedForStatus(kind: QuotaKind, status: number): void {
  if (status >= 500 || status === 408) markQuotaUsed(kind);
}

/**
 * Anthropic's 529. https://platform.claude.com/docs/en/api/errors lists it as
 * "529 - overloaded_error: The API is temporarily overloaded." It does not say
 * in so many words that the request was not processed; it is treated as no
 * work because it is Anthropic's own code for turning a request away under load
 * (a proxy does not produce it, unlike a 502/503/504), and an overload is the
 * outage these refunds exist for. Every other status follows
 * `markQuotaUsedForStatus`. For the callers of api.anthropic.com only.
 */
const ANTHROPIC_OVERLOADED = 529;

/** `markQuotaUsedForStatus` for an Anthropic answer: a 529 is no work. */
export function markAnthropicUsedForStatus(status: number): void {
  if (status !== ANTHROPIC_OVERLOADED) markQuotaUsedForStatus('ai', status);
}

/** `markQuotaUsedUnlessNoWork` for a thrown Anthropic SDK error: a 529 is no work. */
export function markAnthropicUsedUnlessNoWork(err: unknown): void {
  if ((err as { status?: unknown } | null)?.status !== ANTHROPIC_OVERLOADED) markQuotaUsedUnlessNoWork('ai', err);
}

/**
 * Called when a provider call THREW. The unit is used unless the error proves
 * no work was done: the request never reached the provider (NEVER_SENT), or
 * the provider refused it (`err.status`, as the Anthropic SDK and the Signum
 * client report it, judged by `markQuotaUsedForStatus`). A timeout or an abort
 * proves nothing: the provider may have done, and billed, the work, so it
 * counts as use. Otherwise a tenant whose prompts reliably time out would be
 * bounded only by the 15-minute bucket.
 */
export function markQuotaUsedUnlessNoWork(kind: QuotaKind, err: unknown): void {
  const e = (err ?? {}) as { status?: unknown; code?: unknown; cause?: { code?: unknown } | null };
  if (typeof e.status === 'number') {
    markQuotaUsedForStatus(kind, e.status);
    return;
  }
  if (NEVER_SENT.has(String(e.cause?.code ?? e.code))) return;
  markQuotaUsed(kind);
}

/**
 * nodemailer 8 codes (lib/smtp-connection, lib/errors.js) for failures that
 * leave the message unsent: DNS, TLS set-up, login, missing credentials, an
 * envelope or message the server refused, a bad configuration.
 */
const SMTP_NOT_SENT = new Set(['EDNS', 'ETLS', 'EREQUIRETLS', 'EAUTH', 'ENOAUTH', 'EOAUTH2', 'EENVELOPE', 'EMESSAGE', 'ECONFIG']);

/**
 * Called when `transporter.sendMail` THREW. The same rule as for a provider:
 * the send unit is used unless the error proves the message was not accepted.
 *  - one of SMTP_NOT_SENT;
 *  - a 4xx/5xx SMTP reply (`responseCode`): the server answered with a refusal;
 *  - a socket error while connecting (nodemailer reports it as ESOCKET and
 *    keeps Node's `syscall`): it never connected.
 * A timeout (ETIMEDOUT: nodemailer uses it for the connect, the greeting AND an
 * idle socket mid-message, so it proves nothing), a socket error after
 * connecting, a closed connection, or anything else counts as use: the server
 * may already have accepted the message.
 */
export function markSendUsedUnlessNotSent(err: unknown): void {
  const e = (err ?? {}) as { code?: unknown; responseCode?: unknown; syscall?: unknown };
  if (SMTP_NOT_SENT.has(String(e.code))) return;
  if (typeof e.responseCode === 'number' && e.responseCode >= 400) return;
  if (e.code === 'ESOCKET' && (e.syscall === 'connect' || e.syscall === 'getaddrinfo')) return;
  markQuotaUsed('send');
}
