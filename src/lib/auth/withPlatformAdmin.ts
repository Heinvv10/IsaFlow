import { IMPERSONATION_PROOF_COOKIE } from './impersonation-cookies';
// src/lib/auth/withPlatformAdmin.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import * as Sentry from '@sentry/nextjs';
import { verifyToken } from './gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE } from './cookies';
import { als, type RequestContext } from '@/lib/als';
import { log } from '@/lib/logger';
import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';
import { getAppPool, getPlatformAdminPool } from './withPlatformAdmin.pools';
import { isActiveUserAccount, SUSPENDED_ACCOUNT_ERROR, type UserAccountRow } from './userAccountStatus';

export interface PlatformAdminRequest extends NextApiRequest {
  user: { id: string; email?: string; claims: Record<string, unknown> };
  // Note: no companyId, no companyRole — admin is global.
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

/**
 * Gates admin APIs. Two-pool, two-tx fail-closed:
 *   1. Verify GoTrue token.
 *   2. Short tx on app pool as app_user — read users.role via users_self_read
 *      RLS policy. 403 if not super_admin.
 *   3. Second tx on platform_admin pool (BYPASSRLS) — bind client via ALS,
 *      run handler, commit.
 *
 * If step 2 errors or skips, step 3 never runs — the handler never engages
 * BYPASSRLS until super-admin is confirmed.
 */
export function withPlatformAdmin(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[ACCESS_COOKIE];

    if (!token) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
      });
    }

    let claims;
    try {
      claims = await verifyToken(token, cookies[IMPERSONATION_PROOF_COOKIE]);
    } catch (err) {
      log.warn(
        'withPlatformAdmin: invalid token',
        { message: err instanceof Error ? err.message : String(err) },
        'Auth'
      );
      clearAuthCookies(res);
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' },
      });
    }

    const startedAt = Date.now();

    // ── Gate: super-admin check via app_user + RLS ────────────────────────────
    const appClient = await getAppPool().connect();
    let role: string | undefined;
    let standing: UserAccountRow | null = null;
    try {
      await appClient.query('BEGIN');
      await appClient.query('SET LOCAL ROLE app_user');
      await appClient.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);
      // Standing is read in the SAME query as the role — the row is already
      // being fetched, so the gate costs no extra round trip.
      const result = await appClient.query<{ role: string } & UserAccountRow>(
        `SELECT role, is_active, status, suspended_at FROM users WHERE id = auth.uid()`
      );
      role = result.rows[0]?.role;
      standing = result.rows[0] ?? null;
      await appClient.query('COMMIT');
    } catch (err) {
      try { await appClient.query('ROLLBACK'); } catch { /* secondary */ }
      throw err; // Fail-closed — withErrorHandler returns 500.
    } finally {
      appClient.release();
    }

    if (role !== 'super_admin') {
      return res.status(403).json({
        success: false,
        error: { code: 'NOT_SUPER_ADMIN', message: 'Platform-admin role required' },
      });
    }

    // Account standing, checked AFTER the role gate and BEFORE the BYPASSRLS
    // pool is touched. A suspended super_admin must not reach a connection that
    // ignores every RLS policy in the database.
    //
    // This cannot lock an admin out of the console by way of a missing profile:
    // no users row means `role` is undefined, which the check above already
    // refuses as NOT_SUPER_ADMIN. Reaching this line proves the row exists.
    if (!isActiveUserAccount(standing)) {
      log.warn('withPlatformAdmin: super_admin account not in good standing', {
        userId: claims.sub,
        url: req.url,
      }, 'Auth');
      clearAuthCookies(res);
      return res.status(403).json({ success: false, error: { ...SUSPENDED_ACCOUNT_ERROR } });
    }

    // ── Handler tx: platform_admin pool (BYPASSRLS) ──────────────────────────
    const adminClient = await getPlatformAdminPool().connect();
    // The connection authenticates as the platform_admin Postgres role
    // (BYPASSRLS). DO NOT add SET LOCAL ROLE app_user here — that would
    // drop BYPASSRLS and re-apply RLS policies, defeating the purpose of
    // this middleware. The jwt.claims GUC below is only so audit triggers
    // that call auth.uid() still record the actor.
    try {
      await adminClient.query('BEGIN');
      await adminClient.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify(claims),
      ]);

      (req as PlatformAdminRequest).user = {
        id: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        claims: claims as Record<string, unknown>,
      };

      // Hold a reference to the ALS context so we can read criticalAuditFailed
      // after the handler returns (M6).
      const ctx: RequestContext = {
        client: adminClient,
        userId: claims!.sub,
        claims: claims as Record<string, unknown>,
      };
      const runHandler = async () =>
        als.run(ctx, async () => { await handler(req, res); });

      if (process.env.SENTRY_ENABLED === 'true') {
        await Sentry.withIsolationScope(async () => {
          Sentry.setTag('admin', 'true');
          setTenantTags({ userId: claims!.sub, route: sanitizeRoute(req.url) });
          await runHandler();
        });
      } else {
        await runHandler();
      }

      // M6: a CRITICAL_ACTIONS audit write failed somewhere in the handler. Even
      // if the route's own catch swallowed the CriticalAuditError and returned a
      // response, the privileged mutation must NOT persist without its audit
      // row — ROLLBACK instead of COMMIT (fail-closed).
      if (ctx.criticalAuditFailed) {
        await adminClient.query('ROLLBACK');
        log.error(
          'withPlatformAdmin: critical audit write failed — admin action rolled back',
          { url: req.url, userId: claims!.sub },
          'Auth'
        );
        if (!res.headersSent) {
          res.status(500).json({
            success: false,
            error: { code: 'AUDIT_WRITE_FAILED', message: 'Action aborted: audit log could not be written.' },
          });
        }
        return;
      }

      await adminClient.query('COMMIT');
    } catch (err) {
      try { await adminClient.query('ROLLBACK'); } catch { /* secondary */ }
      throw err;
    } finally {
      adminClient.release();
      const ms = Date.now() - startedAt;
      if (ms > 200) log.info('withPlatformAdmin slow request', { ms, url: req.url }, 'Auth');
      if (process.env.SENTRY_ENABLED === 'true') {
        Sentry.metrics.distribution('auth.withPlatformAdmin.duration_ms', ms, {
          unit: 'millisecond',
        });
      }
    }
  };
}
