/**
 * Resolving a share token, for callers with NO authenticated session.
 *
 * Four rules this file exists to enforce, in order:
 *  1. The company comes from the LINK ROW. Nothing this function returns is
 *     derived from the request, so a caller cannot steer it at another tenant.
 *  2. Expiry and revocation are checked here, on every view, on the row found
 *     by the same lookup. Withdrawal is immediate.
 *  3. Every hit that matches a row is written to share_link_views, including a
 *     hit on a dead link — that record is how a withdrawn link being circulated
 *     becomes visible. The write is NOT swallowed: if the audit row cannot be
 *     written the view does not happen.
 *  4. The rate limiter fails CLOSED. A limiter outage answers `rate_limited`,
 *     never `ok`, because the limiter is the only thing bounding an
 *     unauthenticated caller here.
 *
 * Note this runs on the pool connection, which is a superuser and therefore
 * bypasses RLS (see migration 610). The company_id predicate carried by every
 * downstream query IS the tenancy control here; RLS is the second line, not
 * the first.
 *
 * Nothing in this file logs the raw token, the token hash, or a request URL.
 * The token travels in the URL of the public route, so a log line carrying a
 * URL hands a reader of the logs a working link; `redactShareToken` below is
 * what a caller must put around any URL it logs.
 */
import { sql, type DbRow } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { hashShareToken, isShareTokenShape } from './shareToken';
import { parseSharePackParams, type SharePackParams } from './shareParams';

export interface ResolvedShareLink {
  id: string;
  companyId: string;
  params: SharePackParams;
}

export type ShareResolution =
  | { status: 'ok'; link: ResolvedShareLink }
  | { status: 'expired' | 'revoked' | 'not_found' | 'rate_limited' };

export interface ShareViewContext {
  ip: string | null;
  userAgent: string | null;
}

const IP_MAX = 60;
const IP_WINDOW_SECS = 300;
const TOKEN_MAX = 120;
const TOKEN_WINDOW_SECS = 3600;

/** A 43-character base64url run is a share token wherever it sits directly
 *  after `/share/` or in a `token=` parameter. Both forms are redacted; a
 *  43-character segment anywhere else is left alone, because uuids and ids of
 *  other shapes must stay readable in logs. */
const TOKEN_IN_PATH = /(\/share\/)[A-Za-z0-9_-]{43}/g;
const TOKEN_IN_QUERY = /([?&]token=)[A-Za-z0-9_-]{43}/g;

/** Replace any share token in a URL with `[token]`, so the URL can be logged.
 *  Production request logging writes `req.url` verbatim; anything in this
 *  feature that hands a URL to a log must pass it through here first. */
export function redactShareToken(url: string): string {
  if (!url) return url;
  return url.replace(TOKEN_IN_PATH, '$1[token]').replace(TOKEN_IN_QUERY, '$1[token]');
}

/** Both buckets are charged before the decision so a full per-IP bucket does
 *  not leave the per-token bucket un-charged (and vice versa). A throw from
 *  either is a denial, not a pass. */
async function withinRateLimits(tokenHash: string, ctx: ShareViewContext): Promise<boolean> {
  const ipKey = `share:ip:${ctx.ip ?? 'unknown'}`;
  const tokenKey = `share:token:${tokenHash}`;
  try {
    const [ipOk, tokenOk] = await Promise.all([
      checkRateLimit(ipKey, { max: IP_MAX, windowSecs: IP_WINDOW_SECS }),
      checkRateLimit(tokenKey, { max: TOKEN_MAX, windowSecs: TOKEN_WINDOW_SECS }),
    ]);
    if (ipOk && tokenOk) return true;
    log.warn('Share link rate limit', { ip: ctx.ip, perIp: !ipOk, perToken: !tokenOk }, 'share');
    return false;
  } catch (err) {
    // Fail closed. The limiter is DB-backed; if it is unavailable we cannot
    // bound an unauthenticated caller, so we refuse rather than serve.
    log.error('Share link rate limiter unavailable — failing closed', { ip: ctx.ip, err }, 'share');
    return false;
  }
}

export async function resolveShareLink(token: unknown, ctx: ShareViewContext): Promise<ShareResolution> {
  if (!isShareTokenShape(token)) return { status: 'not_found' };

  const tokenHash = hashShareToken(token);
  // Keyed on the HASH so no raw token reaches the rate-limit table.
  if (!(await withinRateLimits(tokenHash, ctx))) return { status: 'rate_limited' };

  const rows = (await sql`
    SELECT id, company_id, params, expires_at, revoked_at
    FROM share_links
    WHERE token_hash = ${tokenHash}
    LIMIT 1
  `) as DbRow[];

  const row = rows[0];
  if (!row) {
    log.warn('Share link not found', { ip: ctx.ip }, 'share');
    return { status: 'not_found' };
  }

  const linkId = String(row.id);
  const companyId = String(row.company_id);

  if (row.revoked_at) {
    await recordShareView(companyId, linkId, 'revoked', ctx);
    log.warn('Revoked share link presented', { companyId, shareLinkId: linkId, ip: ctx.ip }, 'share');
    return { status: 'revoked' };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await recordShareView(companyId, linkId, 'expired', ctx);
    return { status: 'expired' };
  }

  // The stored params were written through parseSharePackParams at creation,
  // so this only rejects a row edited outside the application. Re-parsing means
  // a hand-edited `params` cannot reach a report builder as a trusted object.
  const params = parseSharePackParams(row.params);
  if (!params) {
    log.error('Share link has unusable params', { companyId, shareLinkId: linkId }, 'share');
    return { status: 'not_found' };
  }

  await recordShareView(companyId, linkId, 'ok', ctx);
  await sql`
    UPDATE share_links
    SET view_count = view_count + 1, last_viewed_at = NOW()
    WHERE id = ${linkId}::uuid AND company_id = ${companyId}::uuid
  `;
  log.info('Share link viewed', { companyId, shareLinkId: linkId }, 'share');

  return { status: 'ok', link: { id: linkId, companyId, params } };
}

export async function recordShareView(
  companyId: string,
  shareLinkId: string,
  outcome: 'ok' | 'expired' | 'revoked',
  ctx: ShareViewContext,
): Promise<void> {
  await sql`
    INSERT INTO share_link_views (company_id, share_link_id, outcome, ip_address, user_agent)
    VALUES (${companyId}::uuid, ${shareLinkId}::uuid, ${outcome}, ${ctx.ip}, ${ctx.userAgent})
  `;
}
