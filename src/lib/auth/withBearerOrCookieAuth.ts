/**
 * Either-or auth wrapper (PRD-10 Layer 3, extensible to Layer 2 OAuth).
 *
 *   - If the request carries a `Bearer pat_…` token, validate as a PAT,
 *     populate auth context inline (req.user, req.companyId, req.companyRole,
 *     req.scopes) under an app_user transaction with set_config jwt claims —
 *     mirroring withAuth's RLS setup so handlers downstream behave identically.
 *   - Otherwise, delegate to the existing cookie-based withAuth.
 *
 * Bearer-authed requests intentionally bypass withCsrf (the Bearer header IS
 * the credential — the existing capture-route pattern at
 * pages/api/accounting/capture/upload.ts:182-207). Routes wrapping this should
 * NOT also wrap withCsrf, or the Bearer caller will get 403s.
 */

import type { NextApiHandler, NextApiResponse, NextApiRequest } from 'next';
import * as Sentry from '@sentry/nextjs';
import pg from 'pg';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import { extractBearerToken } from './captureApiKeyAuth';
import { validatePat } from './personalAccessTokens';
import { validateOauthAccessToken, type OauthAccessContext } from './oauth';
import { withAuth } from './withAuth';
import type { CompanyAuthedRequest } from './withAuth';

/**
 * Auto rate-limit table — must stay in sync with the equivalent table in
 * withAuth.ts. PAT-authed requests skip withAuth entirely, so without this
 * mirror they'd silently bypass per-company rate limits on heavy report routes.
 */
const AUTO_RATE_LIMIT: Array<{ prefix: string; key: string; max: number; windowSecs: number }> = [
  { prefix: '/api/accounting/reports-', key: 'reports', max: 60, windowSecs: 60 },
];

/** Postgres SQLSTATE for invalid_text_representation — i.e. UUID cast errors. */
const PG_INVALID_TEXT_REPRESENTATION = '22P02';

interface BearerAuthedRequest extends CompanyAuthedRequest {
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
    log.warn('withBearerOrCookieAuth pool error', { message: err.message }, 'Auth'),
  );
  return _pool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

export function withBearerOrCookieAuth(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const authHeader = req.headers.authorization;
    const rawToken = extractBearerToken(typeof authHeader === 'string' ? authHeader : undefined);

    // No Bearer header → standard cookie auth path.
    if (!rawToken) return withAuth(handler)(req, res);

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
      return res
        .status(401)
        .json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Unsupported bearer token format' } });
    }

    if (!ctx) {
      return res
        .status(401)
        .json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid, revoked, or expired token' } });
    }

    res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    res.setHeader('Vary', 'Authorization');

    const startedAt = Date.now();
    const client = await getAuthPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      // Synthesize the JWT claims that RLS policies actually read. `sub` keys
      // policies via auth.uid(); `company_id` is read directly by mig 395
      // (practice_client_rate_overrides) and mig 396 (payroll_leave_*) — without
      // it those policies evaluate `NULL = NULL` and silently return zero rows.
      const claims = { sub: ctx.userId, role: 'authenticated', company_id: ctx.companyId };
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [ctx.companyId]);

      // Belt-and-braces membership check — same posture as withAuth. Catches
      // the case where a user's company access was revoked since the PAT was
      // minted (we don't auto-revoke PATs on company_users delete).
      let membership: { rows: Array<{ role: string }> };
      try {
        membership = await client.query<{ role: string }>(
          `SELECT role FROM company_users WHERE user_id = $1::text AND company_id = $2::uuid LIMIT 1`,
          [ctx.userId, ctx.companyId],
        );
      } catch (err) {
        // Only treat invalid-UUID casts as 403 (forged or stale PAT pointing at
        // a non-UUID company). Real DB errors (timeout, pool exhaustion) must
        // propagate to the outer catch so they surface as 500, not as a
        // misleading FORBIDDEN.
        const code = (err as { code?: string } | null)?.code;
        if (code === PG_INVALID_TEXT_REPRESENTATION) {
          await client.query('ROLLBACK');
          return res
            .status(403)
            .json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
        }
        throw err;
      }

      if (membership.rows.length === 0) {
        await client.query('ROLLBACK');
        return res
          .status(403)
          .json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
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

      // Mirror withAuth's per-company rate limit so PAT-authed reports calls
      // don't bypass the limiter that protects the pool from full-GL aggregations.
      const path = req.url?.split('?')[0] ?? '';
      const bucket = AUTO_RATE_LIMIT.find((b) => path.startsWith(b.prefix));
      if (bucket) {
        const allowed = await checkRateLimit(
          `${bucket.key}:${ctx.companyId}`,
          { max: bucket.max, windowSecs: bucket.windowSecs },
        );
        if (!allowed) {
          await client.query('ROLLBACK');
          return res.status(429).json({
            success: false,
            error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again shortly.' },
          });
        }
      }

      const runHandler = async () =>
        als.run({ client, userId: ctx.userId, companyId: ctx.companyId, claims }, async () => {
          await handler(authedReq, res);
        });

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

      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
      throw err;
    } finally {
      client.release();
      const ms = Date.now() - startedAt;
      if (ms > 100) log.info('withBearerOrCookieAuth slow request', { ms, url: req.url }, 'Auth');
    }
  };
}

export type { BearerAuthedRequest };
