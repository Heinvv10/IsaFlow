// src/lib/auth/withUserAuth.ts
import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { verifyToken } from './gotrue';
import { parseCookies, clearAuthCookies, ACCESS_COOKIE } from './cookies';
import { log } from '@/lib/logger';

export interface UserAuthedRequest extends NextApiRequest {
  user: { id: string; email?: string; claims: Record<string, unknown> };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => any;

/** Back-compat alias — callers that imported AuthenticatedNextApiRequest from middleware.ts */
export type AuthenticatedNextApiRequest = UserAuthedRequest;

export function withUserAuth(handler: Handler): NextApiHandler {
  return async (req, res) => {
    const cookies = parseCookies(req);
    const token = cookies[ACCESS_COOKIE];
    if (!token) {
      return res.status(401).json({ success: false, error: { code: 'UNAUTHORIZED', message: 'Authentication required' } });
    }
    try {
      const claims = await verifyToken(token);
      (req as UserAuthedRequest).user = {
        id: claims.sub,
        email: typeof claims.email === 'string' ? claims.email : undefined,
        claims: claims as Record<string, unknown>,
      };
      return handler(req, res);
    } catch (err) {
      log.warn('withUserAuth: invalid token', { message: err instanceof Error ? err.message : String(err) }, 'Auth');
      clearAuthCookies(res);
      return res.status(401).json({ success: false, error: { code: 'INVALID_TOKEN', message: 'Invalid or expired token' } });
    }
  };
}
