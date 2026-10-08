import { IMPERSONATION_PROOF_COOKIE } from './impersonation-cookies';
// src/lib/auth/withPlatformAdmin.ts
import { connectObserved } from './poolTelemetry';
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import * as Sentry from '@sentry/nextjs';
import { verifyToken } from './gotrue';
import { respondIfAuthUnavailable } from './authUpstream';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE } from './cookies';
import type { RequestContext } from '@/lib/als';
import { runOwnedContext, drainAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { rollbackFailed } from '@/lib/rollbackFailed';
import { deferEnd, answerThrow, replayEnd, answerCommitFailed, answerInstead, type DeferredEnd } from './deferredEnd';
import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';
import { getAppPool, getPlatformAdminPool } from './withPlatformAdmin.pools';
import { isActiveUserAccount, SUSPENDED_ACCOUNT_ERROR, type UserAccountRow } from './userAccountStatus';
import { auditFailedAdminRequest, type AdminFailureReason } from './adminFailureAudit';

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
 *      run handler, commit. A 5xx answer (withErrorHandler, inside withAdmin,
 *      caught a throw) or a rollback-only request rolls back instead, and the
 *      route's Set-Cookie/Location are dropped, as in withAuth (Hein,
 *      2026-10-08). Every rolled-back mutating request leaves one
 *      admin_request_failed audit row, written after the rollback on its own
 *      connection (adminFailureAudit.ts).
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
      // D9: GoTrue could not answer. Not a verdict on the token: 503, cookies kept.
      if (respondIfAuthUnavailable(res, err, 'withPlatformAdmin')) return;
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
    const appClient = await connectObserved(getAppPool(), 'platformAdminApp');
    let role: string | undefined;
    let standing: UserAccountRow | null = null;
    let gateUnusable = false;
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
      gateUnusable = await rollbackFailed(appClient, 'withPlatformAdmin gate');
      throw err; // Fail-closed — withErrorHandler returns 500.
    } finally {
      appClient.release(gateUnusable); // R-176: a failed ROLLBACK leaves the transaction open; destroy it, do not pool it
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
    let unusable = false;
    let deferred: DeferredEnd | null = null;
    // Set on every path that rolls the action back; recorded after the answer, in finally.
    let failure: { status: number; reason: AdminFailureReason } | null = null;
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

      // The flush waits for COMMIT or ROLLBACK, as in withAuth: a request that must not commit
      // (criticalAuditFailed, rollbackOnly) must not send the route's 2xx first.
      const flush = deferEnd(res);
      deferred = flush;

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
        afterCommit: [],
      };
      const runHandler = async () =>
        runOwnedContext(ctx, async () => { await handler(req, res); });

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
        // Through rollbackFailed (R-176): bounded, and a failure destroys the connection, which
        // discards the unaudited write just the same. The 500 below stands either way.
        unusable = await rollbackFailed(adminClient, 'withPlatformAdmin');
        log.error(
          'withPlatformAdmin: critical audit write failed — admin action rolled back',
          { url: req.url, userId: claims!.sub, connectionDestroyed: unusable },
          'Auth'
        );
        answerInstead(res, flush, 500, {
          success: false,
          error: { code: 'AUDIT_WRITE_FAILED', message: 'Action aborted: audit log could not be written.' },
        });
        failure = { status: 500, reason: 'audit_write_failed' };
        return;
      }

      const finalizeCtx = { source: 'withPlatformAdmin', userId: claims!.sub };
      // A 5xx means the action failed (withErrorHandler, inside withAdmin, caught a throw and answered 500): its
      // partial writes must not commit, and its Set-Cookie/Location must not go out (impersonate: the target's
      // session behind a 500). als.rollbackOnly (lib/apiJournalDate): this request must not commit, whatever it
      // answered; a <5xx answer would claim a write that did not land, so it becomes the commit-failed 500.
      if (res.statusCode >= 500 || ctx.rollbackOnly) {
        unusable = await rollbackFailed(adminClient, 'withPlatformAdmin');
        failure = { status: Math.max(res.statusCode, 500), reason: res.statusCode >= 500 ? 'rolled_back' : 'rollback_only' };
        if (res.statusCode < 500) answerCommitFailed(res, flush); else replayEnd(res, flush, finalizeCtx, true);
        return;
      }
      await adminClient.query('COMMIT');
      replayEnd(res, flush, finalizeCtx); // never throws: past COMMIT, the catch below must not answer
      drainAfterCommit(ctx); // R-075: background work starts only after COMMIT, off this client
    } catch (err) {
      // `||`: the forced ROLLBACK above may already have failed, and that still condemns the connection.
      const failed = await rollbackFailed(adminClient, 'withPlatformAdmin');
      unusable = failed || unusable;
      // R-159: answered here, not rethrown — a rethrow would leave res.end deferred and the client hanging.
      answerThrow(req, res, deferred, err, { source: 'withPlatformAdmin', userId: claims!.sub, rolledBack: !failed });
      failure = { status: 500, reason: 'threw' };
    } finally {
      adminClient.release(unusable); // R-176: a failed ROLLBACK leaves the transaction open; destroy it, do not pool it
      // After the rollback and the answer, on its own connection: never resurrects the action, never changes the answer.
      if (failure) await auditFailedAdminRequest(req, claims!.sub, failure.status, failure.reason);
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
