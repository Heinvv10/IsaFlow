// src/lib/auth/withAuth.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import * as Sentry from '@sentry/nextjs';
import pg from 'pg';
import { verifyToken } from './gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE } from './cookies';
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';
import { checkRateLimit } from '@/lib/rateLimit';
import { ROLE_HIERARCHY, type AuthRole } from './types';

/**
 * Route categories that get per-company rate limiting applied inside withAuth
 * without each handler having to opt in. Pentest M23.
 * The table is intentionally small — add a pattern here, not a one-off in
 * each handler.
 */
const AUTO_RATE_LIMIT: Array<{ prefix: string; key: string; max: number; windowSecs: number }> = [
  { prefix: '/api/accounting/reports-', key: 'reports', max: 60, windowSecs: 60 },
];

export interface CompanyAuthedRequest extends NextApiRequest {
  user: { id: string; email?: string; claims: Record<string, unknown> };
  companyId: string;
  companyRole: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

/**
 * Role gate — must be composed inside withAuth.
 * Checks req.companyRole against the ROLE_HIERARCHY.
 *
 * Usage: withAuth(withRole('admin')(withErrorHandler(handler)))
 */
export function withRole(requiredRole: AuthRole) {
  return (handler: Handler): Handler => {
    return async (req: NextApiRequest, res: NextApiResponse) => {
      const authedReq = req as CompanyAuthedRequest;
      const userRoleLevel = ROLE_HIERARCHY[authedReq.companyRole as AuthRole] ?? 0;
      const requiredRoleLevel = ROLE_HIERARCHY[requiredRole] ?? 0;
      if (userRoleLevel < requiredRoleLevel) {
        return res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: `This action requires ${requiredRole} role or higher` },
        });
      }
      return handler(req, res);
    };
  };
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
  _pool.on('error', (err) => log.warn('withAuth pool background error', { message: err.message }, 'Auth'));
  return _pool;
}

export function withAuth(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[ACCESS_COOKIE];
    const activeCompanyId = cookies[ACTIVE_COMPANY_COOKIE];

    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    if (!activeCompanyId) {
      return res.status(400).json({ success: false, error: { code: 'NO_ACTIVE_COMPANY', message: 'No active company selected' } });
    }

    let claims;
    try {
      claims = await verifyToken(token);
    } catch (err) {
      log.warn('withAuth: invalid token', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
      clearAuthCookies(res);
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
    }

    const startedAt = Date.now();
    const client = await getAuthPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [activeCompanyId]);

      // Belt-and-braces membership check. Runs under app_user (inside the RLS
      // scope) so this query also validates that the RLS policies don't
      // regress — if app_user can't see its own company_users row, the policy
      // is wrong. Wrapped in try/catch because a forged cookie may contain
      // a non-UUID string, which pg rejects at cast time.
      let membership: { rows: Array<{ role: string }> };
      try {
        membership = await client.query<{ role: string }>(
          `SELECT role FROM company_users WHERE user_id = $1 AND company_id = $2::uuid LIMIT 1`,
          [claims.sub, activeCompanyId]
        );
      } catch {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
      }

      if (membership.rows.length === 0) {
        await client.query('ROLLBACK');
        clearAuthCookies(res);
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
      }

      (req as CompanyAuthedRequest).user = {
        id: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        claims: claims as Record<string, unknown>,
      };
      (req as CompanyAuthedRequest).companyId = activeCompanyId;
      (req as CompanyAuthedRequest).companyRole = membership.rows[0]!.role;

      // Pentest M23: per-company rate limit for well-known heavy route
      // categories. Keeps a single tenant from saturating the pool with
      // full-GL aggregations.
      const path = req.url?.split('?')[0] ?? '';
      const bucket = AUTO_RATE_LIMIT.find((b) => path.startsWith(b.prefix));
      if (bucket) {
        const allowed = await checkRateLimit(
          `${bucket.key}:${activeCompanyId}`,
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
        als.run(
          { client, userId: claims.sub, companyId: activeCompanyId, claims: claims as Record<string, unknown> },
          async () => { await handler(req, res); }
        );

      if (process.env.SENTRY_ENABLED === 'true') {
        await Sentry.withIsolationScope(async () => {
          setTenantTags({ companyId: activeCompanyId, userId: claims!.sub, route: sanitizeRoute(req.url) });
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
      if (ms > 100) log.info('withAuth slow request', { ms, url: req.url }, 'Auth');
      if (process.env.SENTRY_ENABLED === 'true') {
        Sentry.metrics.distribution('auth.withAuth.duration_ms', ms, { unit: 'millisecond' });
      }
    }
  };
}
