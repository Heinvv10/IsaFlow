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
import { getClientIp } from '@/lib/rateLimit';
import { extractBearerToken } from './captureApiKeyAuth';
import { validatePat } from './personalAccessTokens';
import { withAuth } from './withAuth';
import type { CompanyAuthedRequest } from './withAuth';

interface BearerAuthedRequest extends CompanyAuthedRequest {
  scopes?: string[];
  /** Set when Bearer-auth path matched, for downstream auditing/logging. */
  authMethod?: 'cookie' | 'pat' | 'oauth';
  patId?: string;
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

    // Future: branch on rawToken prefix. `pat_` → PAT; `oat_` → OAuth (Layer 2).
    if (!rawToken.startsWith('pat_')) {
      return res
        .status(401)
        .json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Unsupported bearer token format' } });
    }

    const ip = getClientIp(req);
    const ctx = await validatePat(rawToken, ip);
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
      // Synthesize minimum JWT claims so RLS policies (which read sub) work.
      const claims = { sub: ctx.userId, role: 'authenticated' };
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
      } catch {
        await client.query('ROLLBACK');
        return res
          .status(403)
          .json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
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
      authedReq.authMethod = 'pat';
      authedReq.patId = ctx.patId;

      const runHandler = async () =>
        als.run({ client, userId: ctx.userId, companyId: ctx.companyId, claims }, async () => {
          await handler(authedReq, res);
        });

      if (process.env.SENTRY_ENABLED === 'true') {
        await Sentry.withIsolationScope(async () => {
          setTenantTags({ companyId: ctx.companyId, userId: ctx.userId, route: sanitizeRoute(req.url) });
          Sentry.setTag('auth.method', 'pat');
          Sentry.setTag('auth.token_id', ctx.patId);
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
