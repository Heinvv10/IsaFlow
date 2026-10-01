/**
 * Rate limiting for API routes: the per-route helpers and the middleware.
 *
 * The counter itself, the refuse-only cache and the refund live in
 * `@/lib/rateLimitCore` and are re-exported here; import them from this module.
 * Usage-quota refunds are in `@/lib/rateLimitQuota`.
 */

import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { log } from '@/lib/logger';
import { noteQuotaCharge } from '@/lib/quotaUse';
import { checkRateLimit, clampCost, type RateLimitOptions } from '@/lib/rateLimitCore';

export {
  checkRateLimit, clampCost, clearRateLimitCache, refundRateLimit, REFUSAL_TTL_MS,
} from '@/lib/rateLimitCore';
export type { RateLimitOptions } from '@/lib/rateLimitCore';

// ---------------------------------------------------------------------------
// IP extraction (BL-20 — do NOT remove; used by register, forgot-password, etc.)
// ---------------------------------------------------------------------------

export function getClientIp(req: NextApiRequest): string {
  // In production behind nginx/Cloudflare, use the last proxy-added IP.
  // x-forwarded-for format: client, proxy1, proxy2
  // The FIRST entry is client-supplied and therefore spoofable.
  // The LAST entry is appended by the closest trusted proxy (nginx/Cloudflare)
  // and cannot be forged by the client.
  // In a Cloudflare + nginx setup, the real IP is the second-to-last entry;
  // using the last (nginx-appended) is still safe for rate limiting purposes.
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    // If the header appears multiple times Node gives an array; the LAST one is
    // appended by the closest trusted proxy (H8: the old code took forwarded[0],
    // the client-supplied/spoofable header).
    const raw = Array.isArray(forwarded) ? forwarded[forwarded.length - 1] ?? '' : forwarded;
    const ips = raw.split(',').map(s => s.trim()).filter(Boolean);
    return ips[ips.length - 1] || req.socket.remoteAddress || 'unknown';
  }
  return req.socket.remoteAddress || 'unknown';
}

/**
 * Per-IP + per-company + daily-quota limiting for expensive AI/LLM endpoints
 * (pentest H3: an authenticated tenant could otherwise burn the inference budget
 * with unbounded calls). Returns true when ALLOWED, false when it should be 429'd.
 */
export async function checkAiRateLimit(
  req: NextApiRequest,
  companyId: string,
  name: string,
  opts: { ipMax?: number; companyMax?: number; dailyMax?: number; refundUnused?: boolean } = {},
): Promise<boolean> {
  const ip = getClientIp(req);
  const ipMax = opts.ipMax ?? 20;
  const companyMax = opts.companyMax ?? 40;
  const dailyMax = opts.dailyMax ?? 300;
  const allowed =
    (await checkRateLimit(`ai:${name}:ip:${ip}`, { max: ipMax, windowSecs: 900 })) &&
    (await checkRateLimit(`ai:${name}:co:${companyId}`, { max: companyMax, windowSecs: 900 })) &&
    (await checkRateLimit(`ai:${name}:co:${companyId}:day`, { max: dailyMax, windowSecs: 86_400 }));
  // The daily bucket is a budget for AI calls a provider answered, not an abuse
  // limit. `refundUnused` is for routes whose provider call goes through a
  // client that calls markQuotaUsed('ai'); the unit comes back when the request
  // ends without one. The 15-minute buckets always stay charged.
  if (allowed && opts.refundUnused) noteQuotaCharge('ai', `ai:${name}:co:${companyId}:day`, 1);
  return allowed;
}

/**
 * Per-IP + per-company + daily-quota limiting for email-send endpoints.
 * Prevents bulk-send abuse (M13). Returns true when ALLOWED, false when 429'd.
 */
export async function checkSendRateLimit(
  req: NextApiRequest,
  companyId: string,
  name: string,
  opts: { ipMax?: number; companyMax?: number; dailyMax?: number; count?: number; refundUnused?: boolean } = {},
): Promise<boolean> {
  const ip = getClientIp(req);
  const ipMax = opts.ipMax ?? 30;
  const companyMax = opts.companyMax ?? 60;
  const dailyMax = opts.dailyMax ?? 500;
  // `count` is EMAIL VOLUME (recipients in this call). It weights the per-company
  // and per-day buckets, which are volume budgets. The per-IP bucket is a
  // request-RATE limiter (abuse from one source) — one API call is one request
  // regardless of recipient count, so it is always charged 1. Charging the IP
  // bucket per-recipient would wrongly block a single legitimate large batch.
  const volumeCost = opts.count ?? 1;
  const allowed =
    (await checkRateLimit(`send:${name}:ip:${ip}`, { max: ipMax, windowSecs: 900, cost: 1 })) &&
    (await checkRateLimit(`send:${name}:co:${companyId}`, { max: companyMax, windowSecs: 900, cost: volumeCost })) &&
    (await checkRateLimit(`send:${name}:co:${companyId}:day`, { max: dailyMax, windowSecs: 86_400, cost: volumeCost }));
  // As for AI: the daily bucket bounds emails a mail server accepted
  // (markQuotaUsed('send') in emailService.sendEmail).
  if (allowed && opts.refundUnused) noteQuotaCharge('send', `send:${name}:co:${companyId}:day`, clampCost(volumeCost));
  return allowed;
}

/**
 * Per-company throttle for expensive report/export/PDF endpoints (pentest
 * MEDIUM: heavy report/export/PDF routes — PDF rendering, large SQL
 * aggregations — were gated only by auth, with no request-frequency limit,
 * letting a scripted authenticated client drive sustained CPU/memory as a
 * same-tenant resource-exhaustion DoS). Generous window so normal interactive
 * use (clicking "export" a few times while reviewing a report) never trips
 * it. Returns true when ALLOWED, false when it should be 429'd.
 */
export async function checkReportRateLimit(
  companyId: string,
  name: string,
  opts: { max?: number; windowSecs?: number } = {},
): Promise<boolean> {
  const max = opts.max ?? 25;
  const windowSecs = opts.windowSecs ?? 900;
  return checkRateLimit(`report:${name}:co:${companyId}`, { max, windowSecs });
}

// ---------------------------------------------------------------------------
// Middleware wrapper (convenience helper for simple IP-based limiting)
// ---------------------------------------------------------------------------

/**
 * Wraps an API handler with per-IP rate limiting using the Neon-backed counter.
 *
 * `scope` namespaces the counter key per route and is REQUIRED. Without it every
 * wrapped route shared one bucket keyed on the bare IP, so each route applied its
 * own `max` to a counter fed by all of them: a handful of logins exhausted the
 * signup allowance, a password reset consumed the login allowance, and so on.
 * Keep the scope stable — changing it resets that route's live counters.
 */
export function withRateLimit(
  handler: NextApiHandler,
  opts: RateLimitOptions,
  scope: string
): NextApiHandler {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(`${scope}:ip:${ip}`, opts);

    if (!allowed) {
      log.warn('Rate limit exceeded', { ip, scope, max: opts.max, windowSecs: opts.windowSecs }, 'rateLimit');
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
      });
      return;
    }

    await handler(req, res);
  };
}
