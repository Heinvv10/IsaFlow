import { settleControlTransaction } from '@/modules/accounting/services/controls/transactionObservers';
import { getCompanyMembership, type CompanyMembershipRow } from './companyMembership';
/**
 * Shared Bearer-token request pipeline (PRD-10 / MCP).
 * ONE implementation of: token validation (pat_/oat_), app_user transaction
 * with RLS GUCs (request.jwt.claims + app.current_company_id), the
 * company_users membership re-check, the per-company auto rate-limit mirror,
 * ALS scoping, Sentry tagging, and COMMIT/ROLLBACK/release. Consumed by both
 * withBearerOrCookieAuth (cookie fallback) and withBearerAuth (strict,
 * challenge header) — never duplicate this logic.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import * as Sentry from '@sentry/nextjs';
import pg from 'pg';
import '@/lib/pgTypes';
import { ControlIntegrityError, withControlRequest } from '@/modules/accounting/services/controls/context';
import { log } from '@/lib/logger';
import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { validatePat } from './personalAccessTokens';
import { validateOauthAccessToken, type OauthAccessContext } from './oauth';
import type { CompanyAuthedRequest } from './withAuth';
import { isActiveUserAccount, SUSPENDED_ACCOUNT_ERROR, MISSING_PROFILE_ERROR } from './userAccountStatus';

/**
 * Auto rate-limit table — must stay in sync with the equivalent table in
 * withAuth.ts. Bearer-authed requests skip withAuth entirely, so without this
 * mirror they'd silently bypass per-company rate limits on heavy report routes.
 */
const AUTO_RATE_LIMIT: Array<{ prefix: string; key: string; max: number; windowSecs: number }> = [
  { prefix: '/api/accounting/reports-', key: 'reports', max: 60, windowSecs: 60 },
];

const PG_INVALID_TEXT_REPRESENTATION = '22P02';

export interface BearerAuthedRequest extends CompanyAuthedRequest {
  scopes?: string[];
  /** Set when Bearer-auth path matched, for downstream auditing/logging. */
  authMethod?: 'cookie' | 'pat' | 'oauth';
  patId?: string;
  oauthAuthorisationId?: string;
  oauthAppId?: string;
}

let _pool: pg.Pool | null = null;
function getAuthPool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  _pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.AUTH_POOL_MAX ?? 20),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  _pool.on('error', (err) =>
    log.warn('bearerPipeline pool error', { message: err.message }, 'Auth'),
  );
  return _pool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BearerHandler = (req: any, res: NextApiResponse<any>) => any;

export interface BearerRequestOptions {
  /** Called before every auth-failure (401) response — e.g. to set the
   *  WWW-Authenticate challenge header on the strict MCP wrapper. */
  onAuthFailure?: (res: NextApiResponse) => void;
}

export async function runBearerRequest(
  req: NextApiRequest,
  res: NextApiResponse,
  rawToken: string,
  handler: BearerHandler,
  opts: BearerRequestOptions = {},
): Promise<void> {
  const ip = getClientIp(req);

  interface NormalisedCtx {
    userId: string;
    companyId: string;
    scopes: string[];
    method: 'pat' | 'oauth';
    patId?: string;
    oauthAuthorisationId?: string;
    oauthAppId?: string;
  }
  let ctx: NormalisedCtx | null = null;

  if (rawToken.startsWith('pat_')) {
    const pat = await validatePat(rawToken, ip);
    if (pat) ctx = { ...pat, method: 'pat' };
  } else if (rawToken.startsWith('oat_')) {
    const oauth: OauthAccessContext | null = await validateOauthAccessToken(rawToken, ip);
    if (oauth) ctx = {
      userId: oauth.userId,
      companyId: oauth.companyId,
      scopes: oauth.scopes,
      method: 'oauth',
      oauthAuthorisationId: oauth.authorisationId,
      oauthAppId: oauth.oauthAppId,
    };
  } else {
    opts.onAuthFailure?.(res);
    res
      .status(401)
      .json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Unsupported bearer token format' } });
    return;
  }

  if (!ctx) {
    opts.onAuthFailure?.(res);
    res
      .status(401)
      .json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid, revoked, or expired token' } });
    return;
  }

  res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
  res.setHeader('Vary', 'Authorization');

  const startedAt = Date.now();
  const client = await getAuthPool().connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_user');
    const claims = { sub: ctx.userId, role: 'authenticated', company_id: ctx.companyId };
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
    await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [ctx.companyId]);

    let membership: { rows: CompanyMembershipRow[] };
    try {
      membership = await getCompanyMembership(client, ctx.userId, ctx.companyId);
    } catch (err) {
      const code = (err as { code?: string } | null)?.code;
      if (code === PG_INVALID_TEXT_REPRESENTATION) {
        await client.query('ROLLBACK');
        res
          .status(403)
          .json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
        return;
      }
      throw err;
    }

    if (membership.rows.length === 0) {
      await client.query('ROLLBACK');
      res
        .status(403)
        .json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
      return;
    }

    const account = membership.rows[0]!;
    if (account.account_user_id === null) {
      await client.query('ROLLBACK');
      log.warn('bearerPipeline: membership has no users profile', {
        userId: ctx.userId, companyId: ctx.companyId, authMethod: ctx.method, url: req.url,
      }, 'Auth');
      res.status(403).json({ success: false, error: { ...MISSING_PROFILE_ERROR } });
      return;
    }
    if (!isActiveUserAccount(account)) {
      await client.query('ROLLBACK');
      log.warn('bearerPipeline: account not in good standing', {
        userId: ctx.userId, companyId: ctx.companyId, authMethod: ctx.method, url: req.url,
      }, 'Auth');
      res.status(403).json({ success: false, error: { ...SUSPENDED_ACCOUNT_ERROR } });
      return;
    }

    const authedReq = req as BearerAuthedRequest;
    authedReq.user = { id: ctx.userId, claims };
    authedReq.companyId = ctx.companyId;
    authedReq.companyRole = membership.rows[0]!.role;
    authedReq.scopes = ctx.scopes;
    authedReq.authMethod = ctx.method;
    if (ctx.method === 'pat') {
      authedReq.patId = ctx.patId;
    } else {
      authedReq.oauthAuthorisationId = ctx.oauthAuthorisationId;
      authedReq.oauthAppId = ctx.oauthAppId;
    }

    const path = req.url?.split('?')[0] ?? '';
    const bucket = AUTO_RATE_LIMIT.find((b) => path.startsWith(b.prefix));
    if (bucket) {
      const allowed = await checkRateLimit(
        `${bucket.key}:${ctx.companyId}`,
        { max: bucket.max, windowSecs: bucket.windowSecs },
      );
      if (!allowed) {
        await client.query('ROLLBACK');
        res.status(429).json({
          success: false,
          error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
        });
        return;
      }
    }

    // Buffer Next's json/end until COMMIT or ROLLBACK, then flush exactly once.
    let bufferedEndArgs: unknown[] | null = null;
    let handlerEnded = false;
    const realEnd = res.end.bind(res) as (...a: unknown[]) => unknown;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (res as any).end = (...args: unknown[]) => {
      if (handlerEnded) return res; // flush exactly once
      handlerEnded = true;
      bufferedEndArgs = args;
      return res;
    };

    const runHandler = async () => {
      try {
        await withControlRequest(
          { client, userId: ctx.userId, companyId: ctx.companyId, claims },
          { personId: ctx.userId, companyId: ctx.companyId, authMethod: ctx.method,
            connectionId: ctx.patId ?? ctx.oauthAuthorisationId, grantId: ctx.patId ?? ctx.oauthAuthorisationId,
            grantedScopes: ctx.scopes }, async () => { await handler(authedReq, res); });
      } catch (error) {
        if (!(error instanceof ControlIntegrityError)) throw error;
        const body = JSON.stringify({ success: false, data: null,
          message: 'An unexpected error occurred', code: 'CONTROL_INTEGRITY_FAILED' });
        res.statusCode = 500;
        if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
        if (!res.headersSent) res.setHeader('Content-Length', Buffer.byteLength(body));
        bufferedEndArgs = res.headersSent ? [] : [body]; handlerEnded = true;
      } finally { res.end = realEnd as typeof res.end; }
    };

    if (process.env.SENTRY_ENABLED === 'true') {
      await Sentry.withIsolationScope(async () => {
        setTenantTags({ companyId: ctx.companyId, userId: ctx.userId, route: sanitizeRoute(req.url) });
        Sentry.setTag('auth.method', ctx.method);
        Sentry.setTag('auth.token_id', ctx.method === 'pat' ? ctx.patId : ctx.oauthAuthorisationId);
        if (ctx.method === 'oauth') Sentry.setTag('oauth.app_id', ctx.oauthAppId);
        await runHandler();
      });
    } else {
      await runHandler();
    }

    // A 5xx means the request failed (withErrorHandler sits inside and may have
    // caught+responded 500) — never COMMIT its partial writes.
    const handlerFailed = res.statusCode >= 500;
    try {
      await client.query(handlerFailed ? 'ROLLBACK' : 'COMMIT');
        await settleControlTransaction(client, handlerFailed ? 'rolled_back' : 'committed');
    } catch (finalizeErr) {
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
      log.error('bearerPipeline: transaction finalize failed after handler responded', {
        url: req.url,
        status: res.statusCode,
        handlerFailed,
        message: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
      }, 'Auth');
      if (process.env.SENTRY_ENABLED === 'true' && finalizeErr instanceof Error) {
        Sentry.captureException(finalizeErr);
      }
      if (res.headersSent) {
        realEnd(...(bufferedEndArgs ?? []));
      } else {
        // Replace the buffered 2xx with an honest 500 — the write did NOT land.
        const body = JSON.stringify({
          success: false, data: null, message: 'An unexpected error occurred', code: 'COMMIT_FAILED',
        });
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(body));
        realEnd(body);
      }
      return; // finally still runs (release + slow-request log)
    }

    // Transaction durable — replay the buffered flush.
    if (handlerEnded) realEnd(...(bufferedEndArgs ?? []));
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* secondary */ }
    throw err;
  } finally {
    await settleControlTransaction(client, 'unknown');
    client.release();
    const ms = Date.now() - startedAt;
    if (ms > 100) log.info('bearerPipeline slow request', { ms, url: req.url }, 'Auth');
  }
}
