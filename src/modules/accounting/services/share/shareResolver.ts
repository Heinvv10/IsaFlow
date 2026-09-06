/**
 * Resolving a share token, for callers with NO authenticated session.
 *
 * Four rules this file exists to enforce, in order:
 *  1. The company comes from the LINK ROW. Nothing this function returns is
 *     derived from the request, so a caller cannot steer it at another tenant.
 *  2. Expiry and revocation are checked here, on every view, on the row found
 *     by the same lookup. Withdrawal is immediate.
 *  3. EVERY hit past the rate limiter is written to share_link_views —
 *     expired, revoked, and a token that matched no row at all. The record of a
 *     dead link is how a withdrawn link being circulated becomes visible; the
 *     record of an unmatched token is what makes the three dead outcomes cost
 *     the same, which is the other half of the neutral 404. While only a
 *     matched token wrote a row, a caller walking tokens could tell "this link
 *     was withdrawn" from "this link never existed" by timing the response,
 *     which is exactly the fact the neutral page refuses to state.
 *     An unmatched hit names no link and no company because there is none
 *     (migration 613 makes both nullable for `not_found` only).
 *     The write is NOT swallowed: if the audit row cannot be written the view
 *     does not happen. A dead link is audited here, since there is nothing left
 *     to build; a live one is audited by `commitShareView`, which the caller
 *     runs only once the pack it is about to serve exists. Auditing an `ok`
 *     view before the build would leave share_link_views claiming a successful
 *     view the recipient never saw.
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
 * URL hands a reader of the logs a working link; `redactShareToken` in
 * `@/lib/observability/redactShareToken` is what a caller must put around any
 * URL it logs.
 */
import { sql, withTransaction, type DbRow, type TxSql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { checkRateLimit } from '@/lib/rateLimit';
import { hashShareToken, isShareTokenShape } from './shareToken';
import { parseSharePackParams } from './shareParams';
import type { SharePackParams } from '@/modules/accounting/services/reports/packParamsHash';

export interface ResolvedShareLink {
  id: string;
  companyId: string;
  params: SharePackParams;
}

/** What `share_link_views.outcome` may hold — `share_link_views_outcome_chk`
 *  in migrations 610 and 613 is the same list. */
export type ShareViewOutcome = 'ok' | 'expired' | 'revoked' | 'not_found';

export type ShareResolution =
  | { status: 'ok'; link: ResolvedShareLink }
  | { status: 'expired' | 'revoked' | 'not_found' | 'rate_limited' };

/** The pair that identifies a link, always read together off one row. */
export interface ShareLinkIdentity {
  id: string;
  companyId: string;
}

/** Either the pool `sql` or a transaction's `tx` — both are tagged templates. */
type TaggedSql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

export interface ShareViewContext {
  ip: string | null;
  userAgent: string | null;
}

const IP_MAX = 60;
const IP_WINDOW_SECS = 300;
const TOKEN_MAX = 120;
const TOKEN_WINDOW_SECS = 3600;

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
  // Before the rate limiter, and deliberately NOT audited. A string that is not
  // 43 base64url characters was never a token, so there is nothing to walk and
  // nothing to learn; auditing it would hand an unauthenticated caller an
  // unbounded INSERT with no bucket charged yet. Everything past this point is
  // rate limited and audited alike.
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
    // Audited like every other dead outcome, so a probe of an unknown token
    // does the same database work as a probe of a withdrawn one and the two
    // cannot be told apart by timing.
    await recordUnmatchedView(ctx);
    // A prefix of the HASH, never the token: enough to tell one probed token
    // from another across log lines, useless to anyone reading the logs, and
    // the signal that someone is walking tokens.
    log.warn('Share link not found', { ip: ctx.ip, tokenHashPrefix: tokenHash.slice(0, 6) }, 'share');
    return { status: 'not_found' };
  }

  const identity: ShareLinkIdentity = { id: String(row.id), companyId: String(row.company_id) };
  const { id: linkId, companyId } = identity;

  if (row.revoked_at) {
    await recordShareView(identity, 'revoked', ctx);
    log.warn('Revoked share link presented', { companyId, shareLinkId: linkId, ip: ctx.ip }, 'share');
    return { status: 'revoked' };
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await recordShareView(identity, 'expired', ctx);
    return { status: 'expired' };
  }

  // The stored params were written through parseSharePackParams at creation,
  // so this only rejects a row edited outside the application. Re-parsing means
  // a hand-edited `params` cannot reach a report builder as a trusted object.
  const params = parseSharePackParams(row.params);
  if (!params) {
    // A live row the application cannot serve. It answers `not_found` like any
    // other dead outcome, so it is audited like one — against the link, which
    // here exists.
    await recordShareView(identity, 'not_found', ctx);
    log.error('Share link has unusable params', { companyId, shareLinkId: linkId }, 'share');
    return { status: 'not_found' };
  }

  return { status: 'ok', link: { id: linkId, companyId, params } };
}

/** The serving decision this function hands back. `served` means the link was
 *  still live at the moment the view was committed; `withdrawn` means it was
 *  not, and the caller must show the neutral unavailable page instead of the
 *  pack it has already built. */
export type ShareViewCommit = 'served' | 'withdrawn';

/** Commits a view. Separate from `resolveShareLink` and run after the pack is
 *  built, so a builder failure cannot leave share_link_views claiming a view
 *  the recipient never received. A throw here is a refusal to serve: the caller
 *  must degrade rather than show an unaudited pack.
 *
 *  THE LIVENESS CHECK IS REPEATED HERE, in the UPDATE's own WHERE clause, and
 *  that is the point of the clause rather than an accident of copying. The
 *  resolve reads `revoked_at` once, and the pack build between the two is the
 *  slowest thing on this path — it reads the whole ledger twice. A revoke
 *  committing inside that window used to change nothing: the response went out
 *  with the figures and the audit trail recorded a plain 'ok'. Revocation is
 *  the ONLY control a sender has once a link is out, and "withdrawn while the
 *  page was rendering" is exactly when a sender is most likely to be pressing
 *  it. Re-checking in the UPDATE is what makes the check race-free: under READ
 *  COMMITTED the predicate is re-evaluated after the row lock is taken, so a
 *  revoke that committed while we were building is seen, not missed.
 *
 *  Zero rows affected therefore means the link died mid-build. The audit says
 *  WHICH — 'revoked' or 'expired', read back inside the same transaction — so
 *  the trail does not claim a withdrawal for a link that simply timed out, and
 *  no 'ok' row is written for a view that never happened.
 *
 *  One transaction: the audit row and the counter are the same fact. A counter
 *  bumped without an audit row is a view nobody can trace, and an audit row
 *  without a bump makes view_count disagree with the log. Same pattern as the
 *  create-cap lock in shareLinkService. */
export async function commitShareView(link: ShareLinkIdentity, ctx: ShareViewContext): Promise<ShareViewCommit> {
  const outcome = await withTransaction(async (tx: TxSql): Promise<ShareViewOutcome> => {
    const bumped = (await tx`
      UPDATE share_links
      SET view_count = view_count + 1, last_viewed_at = NOW()
      WHERE id = ${link.id}::uuid AND company_id = ${link.companyId}::uuid
        AND revoked_at IS NULL AND expires_at > NOW()
      RETURNING id
    `) as DbRow[];

    if (bumped.length === 0) {
      // Died between the resolve and here. Read the row back to say which, so
      // the audit trail is accurate rather than merely present.
      const rows = (await tx`
        SELECT revoked_at FROM share_links
        WHERE id = ${link.id}::uuid AND company_id = ${link.companyId}::uuid
        LIMIT 1
      `) as DbRow[];
      const dead: ShareViewOutcome = rows[0]?.revoked_at ? 'revoked' : 'expired';
      await recordShareView(link, dead, ctx, tx);
      return dead;
    }

    await recordShareView(link, 'ok', ctx, tx);
    return 'ok';
  });

  if (outcome !== 'ok') {
    log.warn('Share link withdrawn while its pack was being built — not served', {
      companyId: link.companyId, shareLinkId: link.id, outcome,
    }, 'share');
    return 'withdrawn';
  }

  log.info('Share link viewed', { companyId: link.companyId, shareLinkId: link.id }, 'share');
  return 'served';
}

/** `ip_address` and `user_agent` are unbounded TEXT and are filled from request
 *  headers by an unauthenticated caller. Both are truncated here, in the only
 *  function that writes them, so no call site can forget: 45 characters holds
 *  the longest IPv4-mapped IPv6 form, 512 holds any real user agent. */
const IP_MAX_CHARS = 45;
const UA_MAX_CHARS = 512;

function clip(v: string | null, max: number): string | null {
  return v === null ? null : v.slice(0, max);
}

/** Takes the resolved link itself rather than a loose company id, so a caller
 *  cannot pair one tenant's id with another tenant's link. */
export async function recordShareView(
  link: ShareLinkIdentity,
  outcome: ShareViewOutcome,
  ctx: ShareViewContext,
  exec: TaggedSql = sql,
): Promise<void> {
  await exec`
    INSERT INTO share_link_views (company_id, share_link_id, outcome, ip_address, user_agent)
    VALUES (${link.companyId}::uuid, ${link.id}::uuid, ${outcome}, ${clip(ctx.ip, IP_MAX_CHARS)}, ${clip(ctx.userAgent, UA_MAX_CHARS)})
  `;
}

/** The audit row for a token that matched NOTHING: no link id, no company id,
 *  because there is no link and therefore no company, and inventing one would
 *  file a stranger's probe under a tenant that had nothing to do with it.
 *
 *  Its purpose is to make the unmatched outcome cost what the matched-but-dead
 *  outcomes cost. `share_link_views_identity_chk` (migration 613) allows a
 *  null pair for `not_found` and for nothing else, and the tenant RLS policy
 *  reads `company_id IN (...)`, so a null-company row is invisible to every
 *  company — it belongs to the platform.
 *
 *  Not swallowed, for the same reason `recordShareView` is not: a view that
 *  cannot be audited does not happen. */
export async function recordUnmatchedView(ctx: ShareViewContext, exec: TaggedSql = sql): Promise<void> {
  await exec`
    INSERT INTO share_link_views (company_id, share_link_id, outcome, ip_address, user_agent)
    VALUES (NULL, NULL, 'not_found', ${clip(ctx.ip, IP_MAX_CHARS)}, ${clip(ctx.userAgent, UA_MAX_CHARS)})
  `;
}
