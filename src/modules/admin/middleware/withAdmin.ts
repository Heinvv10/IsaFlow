/**
 * Admin Middleware
 * Convenience wrapper: withAuth + withRole('super_admin') + withErrorHandler
 * All admin API routes must be wrapped with this.
 */

import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { checkRateLimit } from '@/lib/rateLimit';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';

/**
 * Wraps a handler with:
 * 1. JWT authentication (withAuth)
 * 2. super_admin role enforcement (withRole)
 * 3. Structured error handling (withErrorHandler)
 *
 * Usage:
 *   export default withAdmin(async (req, res) => { ... });
 */
export function withAdmin(
  handler: (req: AuthenticatedNextApiRequest, res: NextApiResponse) => Promise<void>
): NextApiHandler {
  const rateLimitedHandler = async (req: NextApiRequest, res: NextApiResponse) => {
    // F-03: In-memory rate limiter — not shared across multiple instances.
    // For horizontal scaling, replace with Redis-backed rate limiting (e.g. ioredis + sliding window).
    //
    // F-03: Use the FIRST (leftmost) x-forwarded-for IP — that is the original client IP
    // in standard proxy chains. The last entry would be the most-recently-appended proxy
    // address, not the client, so using ips[0] is correct here.
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (() => {
      if (forwarded) {
        const raw = Array.isArray(forwarded) ? forwarded[0] ?? '' : forwarded;
        const ips = raw.split(',').map((s: string) => s.trim());
        // ips[0] is the original client IP (standard proxy convention)
        return ips[0] || req.socket.remoteAddress || 'unknown';
      }
      return req.socket.remoteAddress || 'unknown';
    })();
    const limited = checkRateLimit(`admin:${ip}`, { windowMs: 60000, maxRequests: 120 });
    if (limited) {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
      });
      return;
    }

    // F-04: CSRF mitigation — require a custom request header on all mutating methods.
    // Browser cross-origin requests cannot set arbitrary headers without a preflight,
    // so this header acts as a lightweight CSRF token for same-origin admin calls.
    if (req.method !== 'GET' && req.headers['x-admin-request'] !== 'true') {
      res.status(403).json({ error: 'Missing required header: X-Admin-Request' });
      return;
    }

    return handler(req as AuthenticatedNextApiRequest, res);
  };
  const errorWrapped = withErrorHandler(rateLimitedHandler);
  const roleWrapped = withRole('super_admin')(errorWrapped);
  return withAuth(roleWrapped) as NextApiHandler;
}
