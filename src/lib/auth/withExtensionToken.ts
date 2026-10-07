// src/lib/auth/withExtensionToken.ts
//
// Middleware for the bank-feed extension ingest endpoint. Verifies the
// HS256 pairing JWT, asserts the connection is still active, and binds
// the request to the connection's tenant via RLS GUC + ALS.
//
// This is intentionally separate from withAuth — the extension calls
// this endpoint cross-origin from the user's browser, has no GoTrue
// session cookie, and should NOT be CSRF-protected (the JWT is the
// auth boundary). Verification path:
//   1. Pull token from Authorization: Bearer <jwt>
//   2. Verify signature + scope
//   3. Load bank_feed_connections row, assert is_active + provider='extension'
//   4. Open a tx pinned to app_user role with company GUC set, run handler

import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { connectObserved } from './poolTelemetry';
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. This file builds its own Pool, so it must not depend on
// src/lib/neon.ts having been imported first. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import type { RequestContext } from '@/lib/als';
import { runOwnedContext, drainAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { authPoolMax } from '@/lib/limits/poolLimits';
import { rollbackError, rollbackFailed } from '@/lib/rollbackFailed';
import { extractBearerToken } from './captureApiKeyAuth';
import { verifyExtensionToken } from './extensionJwt';
import { deferEnd, answerThrow, replayEnd, answerCommitFailed, reportFinalizeFailure, type DeferredEnd } from './deferredEnd';

export interface ExtensionAuthedRequest extends NextApiRequest {
  extension: {
    userId: string;
    companyId: string;
    connectionId: string;
    bankId: string;
    bankAccountId: string;
  };
}

let _pool: pg.Pool | null = null;
function pool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  _pool = new pg.Pool({
    connectionString: url,
    max: authPoolMax(),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  // pg-pool re-emits a pooled or removed client's 'error' on the pool; unlistened, that is an uncaught exception.
  _pool.on('error', (err) => log.warn('withExtensionToken pool error', { message: err.message }, 'Auth'));
  return _pool;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

export function withExtensionToken(handler: Handler): NextApiHandler {
  return async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store, must-revalidate');

    const token = extractBearerToken(req.headers.authorization);
    if (!token) {
      return res.status(401).json({
        success: false,
        error: { code: 'UNAUTHORIZED', message: 'Bearer token required' },
      });
    }

    const claims = await verifyExtensionToken(token);
    if (!claims) {
      return res.status(401).json({
        success: false,
        error: { code: 'INVALID_TOKEN', message: 'Invalid or expired pairing token' },
      });
    }

    // The connectionId in the URL must match the JWT claim — defence-in-depth
    // against a leaked token being used against a different connection.
    const urlConnectionId = (req.query.id as string | undefined) ?? '';
    if (urlConnectionId && urlConnectionId !== claims.connectionId) {
      return res.status(403).json({
        success: false,
        error: { code: 'CONNECTION_MISMATCH', message: 'Token does not match connection' },
      });
    }

    const client = await connectObserved(pool(), 'extensionToken');
    let deferred: DeferredEnd | null = null;
    let unusable = false; // set when a ROLLBACK fails: the connection may still be inside its transaction
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query(`SELECT set_config('app.current_company_id', $1, true)`, [claims.companyId]);
      await client.query(
        `SELECT set_config('request.jwt.claims', $1, true)`,
        [JSON.stringify({ sub: claims.userId, company_id: claims.companyId })],
      );

      const conn = await client.query<{
        id: string;
        company_id: string;
        bank_account_id: string;
        provider: string;
        is_active: boolean;
      }>(
        `SELECT id, company_id, bank_account_id, provider, is_active
           FROM bank_feed_connections
          WHERE id = $1`,
        [claims.connectionId],
      );

      const row = conn.rows[0];
      if (!row || !row.is_active || row.company_id !== claims.companyId) {
        unusable = await rollbackFailed(client, 'withExtensionToken');
        return res.status(403).json({
          success: false,
          error: { code: 'CONNECTION_INACTIVE', message: 'Connection is not active' },
        });
      }
      if (row.provider !== 'extension') {
        unusable = await rollbackFailed(client, 'withExtensionToken');
        return res.status(403).json({
          success: false,
          error: { code: 'WRONG_PROVIDER', message: 'Connection is not an extension provider' },
        });
      }

      (req as ExtensionAuthedRequest).extension = {
        userId: claims.userId,
        companyId: claims.companyId,
        connectionId: claims.connectionId,
        bankId: claims.bankId,
        bankAccountId: row.bank_account_id,
      };

      // Defer the flush until the transaction is finalised — withAuth.ts's
      // pattern. Otherwise the extension reads a 200 for a batch whose COMMIT
      // then fails. res.json/res.send both funnel through res.end.
      const flush = deferEnd(res);
      deferred = flush;

      const ctx: RequestContext = {
        client, userId: claims.userId, companyId: claims.companyId, claims: { sub: claims.userId }, afterCommit: [],
      };
      await runOwnedContext(ctx, async () => { await handler(req, res); });
      // A 5xx means withErrorHandler (inside this wrapper) caught a fault,
      // answered 500, and returned normally — mirrors withAuth.ts: we must
      // NOT COMMIT its partial writes, and must NOT drain afterCommit work
      // queued before the fault.
      const handlerFailed = res.statusCode >= 500;
      const finalizeCtx = { source: 'withExtensionToken', companyId: claims.companyId, userId: claims.userId, extra: { connectionId: claims.connectionId } };
      if (handlerFailed) {
        // Nothing is meant to commit, so the handler's own answer stands even if this ROLLBACK
        // fails: the connection is then destroyed and the server discards the transaction (R-176).
        const rollbackErr = await rollbackError(client, 'withExtensionToken');
        unusable = rollbackErr !== null;
        if (rollbackErr) reportFinalizeFailure(req, res, rollbackErr, { ...finalizeCtx, handlerFailed, connectionDestroyed: true, component: 'extensionAuth' });
      } else {
        try {
          await client.query('COMMIT');
        } catch (finalizeErr) {
          // The COMMIT failed after the handler "responded": the write did not land, or its
          // outcome is unknown. Roll back, then replace the buffered 2xx with an honest 500.
          unusable = await rollbackFailed(client, 'withExtensionToken');
          reportFinalizeFailure(req, res, finalizeErr, { ...finalizeCtx, handlerFailed, connectionDestroyed: unusable, component: 'extensionAuth' });
          answerCommitFailed(res, flush);
          return; // finally still runs (release + slow-request log)
        }
      }
      // replayEnd never throws: past COMMIT, the catch below must not ROLLBACK or answer 500.
      replayEnd(res, flush, {
        source: 'withExtensionToken', companyId: claims.companyId, userId: claims.userId,
        extra: { connectionId: claims.connectionId },
      }, handlerFailed);
      if (!handlerFailed) drainAfterCommit(ctx);
    } catch (err) {
      // R-159: answer the throw here; see withAuth.
      const failed = await rollbackFailed(client, 'withExtensionToken');
      unusable = unusable || failed; // an earlier failed ROLLBACK still condemns the connection
      answerThrow(req, res, deferred, err, {
        source: 'withExtensionToken', companyId: claims.companyId, userId: claims.userId,
        extra: { connectionId: claims.connectionId }, rolledBack: !failed,
      });
    } finally {
      client.release(unusable); // R-176: a failed ROLLBACK leaves the transaction open; destroy it, do not pool it
    }
  };
}
