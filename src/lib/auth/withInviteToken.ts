// src/lib/auth/withInviteToken.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import pg from 'pg';
// Side-effect import: registers the DATE (OID 1082) parser for every pg Pool
// in this process. This file builds its own Pool, so it must not depend on
// src/lib/neon.ts having been imported first. See src/lib/pgTypes.ts.
import '@/lib/pgTypes';
import type { RequestContext } from '@/lib/als';
import { runOwnedContext, drainAfterCommit } from '@/lib/afterCommit';
import { hashInviteToken } from './inviteToken';

let _pool: pg.Pool | null = null;
function pool(): pg.Pool {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  _pool = new pg.Pool({
    connectionString: url,
    max: 5,
    ssl:
      process.env.DATABASE_SSL === 'strict'
        ? { rejectUnauthorized: true }
        : process.env.DATABASE_SSL === 'disable'
          ? false
          : { rejectUnauthorized: false },
  });
  return _pool;
}

export interface InviteTokenRequest extends NextApiRequest {
  /**
   * What `company_invitations.token` actually holds. Compare against this.
   * The raw token from the link is deliberately not exposed: every consumer
   * matches on the digest, and handing the raw secret to handlers invites it
   * back into a query or a log line.
   */
  inviteTokenHash: string;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

export function withInviteToken(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const rawToken = (req.query.token as string | undefined) ?? (req.body?.token as string | undefined);
    if (typeof rawToken !== 'string' || rawToken.length < 16) {
      return res.status(400).json({ success: false, error: { code: 'BAD_TOKEN', message: 'Invite token missing' } });
    }
    const tokenHash = hashInviteToken(rawToken);
    (req as InviteTokenRequest).inviteTokenHash = tokenHash;

    const client = await pool().connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      // The RLS policy invites_by_token compares this GUC to the stored column,
      // which holds the digest — never the raw token from the link.
      await client.query(`SELECT set_config('app.invite_token', $1, true)`, [tokenHash]);
      const ctx: RequestContext = { client, userId: '', companyId: '', claims: {}, afterCommit: [] };
      await runOwnedContext(ctx, async () => { await handler(req, res); });
      await client.query('COMMIT');
      drainAfterCommit(ctx);
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch { /* secondary */ }
      throw err;
    } finally {
      client.release();
    }
  };
}
