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
import { als } from '@/lib/als';
import { log } from '@/lib/logger';
import { extractBearerToken } from './captureApiKeyAuth';
import { verifyExtensionToken } from './extensionJwt';

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

      await als.run(
        { client, userId: claims.userId, companyId: claims.companyId, claims: { sub: claims.userId } },
        async () => { await handler(req, res); },
      );
      await client.query('COMMIT');
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
      log.error(
        'withExtensionToken handler error',
        { error: err instanceof Error ? err.message : String(err), connectionId: claims.connectionId },
        'extensionAuth',
      );
      throw err;
    } finally {
      client.release();
    }
  };
}
