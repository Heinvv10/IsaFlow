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
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. This file builds its own Pool, so it must not depend on
// src/lib/neon.ts having been imported first. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import type { RequestContext } from '@/lib/als';
import { runOwnedContext, drainAfterCommit } from '@/lib/afterCommit';
import { log } from '@/lib/logger';
import { extractBearerToken } from './captureApiKeyAuth';
import { verifyExtensionToken } from './extensionJwt';
import { deferEnd, answerThrow, type DeferredEnd } from './deferredEnd';

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

    const client = await pool().connect();
    let deferred: DeferredEnd | null = null;
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
        await client.query('ROLLBACK');
        return res.status(403).json({
          success: false,
          error: { code: 'CONNECTION_INACTIVE', message: 'Connection is not active' },
        });
      }
      if (row.provider !== 'extension') {
        await client.query('ROLLBACK');
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
      try {
        await client.query(handlerFailed ? 'ROLLBACK' : 'COMMIT');
      } catch (finalizeErr) {
        try { await client.query('ROLLBACK'); } catch { /* secondary */ }
        log.error('withExtensionToken: transaction finalize failed after handler responded', {
          status: res.statusCode, handlerFailed, connectionId: claims.connectionId,
          message: finalizeErr instanceof Error ? finalizeErr.message : String(finalizeErr),
        }, 'extensionAuth');
        if (res.headersSent) {
          flush.realEnd(...(flush.args ?? []));
        } else {
          const body = JSON.stringify({ success: false, data: null, message: 'An unexpected error occurred', code: 'COMMIT_FAILED' });
          res.statusCode = 500;
          res.setHeader('Content-Type', 'application/json; charset=utf-8');
          res.setHeader('Content-Length', Buffer.byteLength(body));
          flush.realEnd(body);
        }
        return;
      }
      if (flush.ended) flush.realEnd(...(flush.args ?? []));
      if (!handlerFailed) drainAfterCommit(ctx);
    } catch (err) {
      // R-159: answer the throw here; see withAuth.
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
      answerThrow(req, res, deferred, err, {
        source: 'withExtensionToken', companyId: claims.companyId, userId: claims.userId,
        extra: { connectionId: claims.connectionId },
      });
    } finally {
      client.release();
    }
  };
}
