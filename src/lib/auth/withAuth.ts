import { finalizeRequestTransaction } from './transactionFinalization';
import { settleControlTransaction } from '@/modules/accounting/services/controls/transactionObservers';
import { getCompanyMembership, type CompanyMembershipRow } from './companyMembership';
import { IMPERSONATION_PROOF_COOKIE } from './impersonation-cookies';
// src/lib/auth/withAuth.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import * as Sentry from '@sentry/nextjs';
import { verifyToken } from './gotrue';
import { authenticatePrintToken } from './withAuthPrint';
import { getAuthPool } from './authPool';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE, ACTIVE_COMPANY_COOKIE } from './cookies';
import { ControlIntegrityError, withControlRequest } from '@/modules/accounting/services/controls/context';
import { log } from '@/lib/logger';
import { setTenantTags, sanitizeRoute } from '@/lib/sentry/tags';
import { checkRateLimit } from '@/lib/rateLimit';
import { isActiveUserAccount, SUSPENDED_ACCOUNT_ERROR, MISSING_PROFILE_ERROR } from './userAccountStatus';

// Re-exported so every existing `import { withRole } from '@/lib/auth/withAuth'`
// keeps working; the implementation moved to withRole.ts (300-line ceiling).
export { withRole } from './withRole';

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

export function withAuth(handler: Handler): NextApiHandler {
  return async (req, res) => {
    // Every authenticated response is tenant-scoped. Browsers cache by URL,
    // and our Vary header previously didn't include Cookie — meaning a
    // company switch could be served stale data from a different tenant's
    // cached response. no-store + Vary: Cookie guarantees tenant isolation
    // survives HTTP caching.
    res.setHeader('Cache-Control', 'private, no-store, must-revalidate');
    res.setHeader('Vary', 'Cookie');

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
      claims = await verifyToken(token, cookies[IMPERSONATION_PROOF_COOKIE]);
    } catch (err) {
      // Print-pipeline fallback (src/lib/pdf/renderPagePdf.ts): a headless
      // Chromium request carries a short-lived print token instead of a
      // GoTrue session in the SAME cookie. The whole decision lives in
      // authenticatePrintToken (withAuthPrint.ts), which calls the tested
      // verifyPrintToken rather than re-checking the bound paths here — an
      // inline copy of that check is how the exact-match rule ended up with
      // no production caller. It is a no-op (always rejected) unless
      // PRINT_TOKEN_SECRET is set, so the branch is disabled by default.
      // The method goes in too: a print token authorises GETs only, so a
      // captured one cannot become a write credential if a bound route ever
      // grows a write method.
      const requestPath = req.url?.split('?')[0] ?? '';
      const outcome = authenticatePrintToken(token, requestPath, activeCompanyId, req.method);
      if (outcome.kind === 'rejected') {
        if (outcome.clearCookies) {
          log.warn('withAuth: invalid token', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
          clearAuthCookies(res);
        } else {
          // A genuine print token bound elsewhere — AppLayout's own background
          // calls present the same cookie. Clearing here wiped the render's
          // credentials mid-render.
          log.warn('withAuth: print token not valid for this request', { requestPath, activeCompanyId }, 'Auth');
        }
        return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
      }
      log.info('withAuth: print token accepted', {
        companyId: outcome.payload.companyId,
        userId: outcome.payload.userId,
        paths: outcome.payload.paths,
      }, 'Auth');
      claims = { sub: outcome.payload.userId } as Awaited<ReturnType<typeof verifyToken>>;
    }

    const startedAt = Date.now();
    const client = await getAuthPool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)]);
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [activeCompanyId]);

      // Belt-and-braces membership + account-standing check. Runs under
      // app_user (inside the RLS scope) so this query also validates that the
      // RLS policies don't regress — if app_user can't see its own
      // company_users row, the policy is wrong. Wrapped in try/catch because a
      // forged cookie may contain a non-UUID string, which pg rejects at cast
      // time.
      //
      // The LEFT JOIN onto users is what makes suspension real: suspendUser()
      // flips is_active/suspended_at but cannot revoke a live GoTrue cookie,
      // so without this the suspended user keeps full access until the token
      // expires. The join is LEFT so a membership with no profile behind it
      // (company_users.user_id has no FK to users) is denied by the predicate
      // rather than silently disappearing into the membership-missing branch.
      // Neither user_id nor users.id is cast: both are TEXT columns.
      let membership: { rows: CompanyMembershipRow[] };
      try {
        membership = await getCompanyMembership(client, claims.sub, activeCompanyId);
      } catch {
        await client.query('ROLLBACK');
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
      }

      if (membership.rows.length === 0) {
        await client.query('ROLLBACK');
        clearAuthCookies(res);
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Not a member of this company' } });
      }

      // Two distinct refusals. A membership with no profile behind it is a
      // broken data state, not a suspension — conflating them sends an operator
      // hunting for a suspension that was never applied.
      const account = membership.rows[0]!;
      if (account.account_user_id === null) {
        await client.query('ROLLBACK');
        log.warn('withAuth: membership has no users profile', {
          userId: claims.sub,
          companyId: activeCompanyId,
          url: req.url,
        }, 'Auth');
        clearAuthCookies(res);
        return res.status(403).json({ success: false, error: { ...MISSING_PROFILE_ERROR } });
      }
      if (!isActiveUserAccount(account)) {
        await client.query('ROLLBACK');
        log.warn('withAuth: account not in good standing', {
          userId: claims.sub,
          companyId: activeCompanyId,
          url: req.url,
        }, 'Auth');
        clearAuthCookies(res);
        return res.status(403).json({ success: false, error: { ...SUSPENDED_ACCOUNT_ERROR } });
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

      // ── Defer the response flush until AFTER the transaction is finalised ──
      // The handler calls res.json/res.end INSIDE this open transaction. If the
      // response flushes before COMMIT, a client that immediately refetches can
      // read the DB before the write has landed (reproduced: a GET 404'd 78ms
      // after a 201). Next's res.json/res.send both funnel through res.end
      // (api-utils/node sendData/sendJson), so patching res.end captures every
      // apiResponse.* helper plus the xlsx/pdf buffer routes. We buffer the
      // single final end(), COMMIT/ROLLBACK on the resolved status, then replay.
      let bufferedEndArgs: unknown[] | null = null;
      let handlerEnded = false;
      const realEnd = res.end.bind(res) as (...a: unknown[]) => unknown;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (res as any).end = (...args: unknown[]) => {
        if (handlerEnded) return res; // double-end guard — flush exactly once
        handlerEnded = true;
        bufferedEndArgs = args;
        return res;
      };

      const runHandler = async () => {
        try {
          await withControlRequest(
            { client, userId: claims.sub, companyId: activeCompanyId, claims: claims as Record<string, unknown> },
            { personId: claims.sub, companyId: activeCompanyId, authMethod: 'cookie' },
            async () => { await handler(req, res); }
          );
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
          setTenantTags({ companyId: activeCompanyId, userId: claims!.sub, route: sanitizeRoute(req.url) });
          await runHandler();
        });
      } else {
        await runHandler();
      }

      // Finalise on the resolved status. A 5xx means the request failed — most
      // commonly withErrorHandler (which sits INSIDE withAuth) caught an error,
      // responded 500, and returned normally; we must NOT COMMIT its partial
      // writes. <5xx commits (4xx keeps today's behaviour — handlers that
      // validate-then-4xx almost always return before any write).
      const handlerFailed = res.statusCode >= 500;
      try {
        await finalizeRequestTransaction(client, handlerFailed);
      } catch (finalizeErr) {
        // The transaction could not be finalised after the handler "responded".
        // Best-effort rollback, then (for the common deferred-flush case where
        // headers have NOT yet been sent) replace the buffered 2xx flush with an
        // honest 500 — today that is a silent lie (a committed-failed 200).
        try { await client.query('ROLLBACK'); } catch { /* secondary */ }
        log.error('withAuth: transaction finalize failed after handler responded', {
          url: req.url,
          status: res.statusCode,
          handlerFailed, // distinguishes a failed COMMIT (2xx) from a failed ROLLBACK (5xx)
          message: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
        }, 'Auth');
        if (process.env.SENTRY_ENABLED === 'true' && finalizeErr instanceof Error) {
          Sentry.captureException(finalizeErr);
        }
        if (res.headersSent) {
          // A streaming/redirect route already flushed headers before COMMIT
          // (e.g. an xlsx export that pipes via res.write, or res.redirect's
          // writeHead) — the status can't be rewritten, so just complete the
          // response. Always replay so the socket is closed, never hung, even
          // if the handler wrote bytes without calling end (bufferedEndArgs null).
          realEnd(...(bufferedEndArgs ?? []));
        } else {
          const body = JSON.stringify({
            success: false,
            data: null,
            message: 'An unexpected error occurred',
            code: 'COMMIT_FAILED',
          });
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(body));
          realEnd(body);
        }
        return; // finally still runs (release + slow-request log)
      }

      // Transaction durable — now replay the buffered flush. If the handler
      // never responded there is nothing to replay (Next surfaces its own
      // "resolved without sending a response" path, unchanged from before).
      if (handlerEnded) realEnd(...(bufferedEndArgs ?? []));
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
      throw err;
    } finally {
      await settleControlTransaction(client, 'unknown');
      client.release();
      const ms = Date.now() - startedAt;
      if (ms > 100) log.info('withAuth slow request', { ms, url: req.url }, 'Auth');
      if (process.env.SENTRY_ENABLED === 'true') {
        Sentry.metrics.distribution('auth.withAuth.duration_ms', ms, { unit: 'millisecond' });
      }
    }
  };
}
