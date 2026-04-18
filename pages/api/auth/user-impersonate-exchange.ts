/**
 * User Impersonation Token Exchange
 * GET /api/auth/user-impersonate-exchange?token=<jwt>
 *
 * Called by pages/impersonate.tsx (getServerSideProps) with a short-lived
 * impersonation JWT minted by POST /api/admin/users/[id]/impersonate.
 *
 * Validates the JWT + live session, then sets the auth cookie so the browser
 * is logged in as the target user. Redirects to /accounting on success.
 *
 * Security:
 * - Token must be a valid, unexpired JWT (jose verifyToken)
 * - Session row must exist in user_sessions and not be expired
 * - Session metadata.impersonated_by must be set (proves admin origin)
 * - Single-use: session expires_at is 1 hour, token itself carries same expiry
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { serialize } from 'cookie';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { verifyToken } from '@/lib/auth/jwt';
import { ACCESS_COOKIE as AUTH_COOKIE_NAME } from '@/lib/auth/cookies';
import { withErrorHandler } from '@/lib/api-error-handler';
import crypto from 'crypto';

type Row = Record<string, unknown>;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const token = req.query.token as string | undefined;
  if (!token) {
    return res.status(400).json({ success: false, error: 'Missing token' });
  }

  // 1. Verify JWT signature + expiry
  const payload = await verifyToken(token);
  if (!payload) {
    log.warn('user-impersonate-exchange: invalid or expired token', {}, 'auth');
    return res.status(401).json({ success: false, error: 'Invalid or expired impersonation token' });
  }

  // 2. Confirm session exists, is unexpired, and has impersonated_by metadata
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const rows = (await sql`
    SELECT id, user_id, expires_at, metadata
    FROM user_sessions
    WHERE token_hash = ${tokenHash}
      AND expires_at > NOW()
    LIMIT 1
  `) as Row[];

  const session = rows[0];
  if (!session) {
    log.warn('user-impersonate-exchange: session not found or expired', { sub: payload.sub }, 'auth');
    return res.status(401).json({ success: false, error: 'Session not found or expired' });
  }

  const metadata = session.metadata as Record<string, unknown> | null;
  if (!metadata?.impersonated_by) {
    log.warn('user-impersonate-exchange: missing impersonated_by metadata', { sessionId: session.id }, 'auth');
    return res.status(403).json({ success: false, error: 'Token was not issued by admin impersonation' });
  }

  // 3. Set the auth cookie — same flags as login.ts
  const isProd = process.env.NODE_ENV === 'production';
  const cookie = serialize(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 60 * 60, // 1 hour — matches impersonation session lifetime
    ...(isProd ? { domain: '.isaflow.co.za' } : {}),
  });

  res.setHeader('Set-Cookie', cookie);

  log.info('User impersonation session activated', {
    targetUserId: payload.sub,
    impersonatedBy: metadata.impersonated_by,
    sessionId: session.id,
  }, 'auth');

  return res.status(200).json({ success: true, data: { redirect: '/accounting' } });
}

export default withErrorHandler(handler);
