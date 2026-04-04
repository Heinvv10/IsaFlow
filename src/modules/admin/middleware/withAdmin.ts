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
    // Use the last x-forwarded-for entry (proxy-appended) to prevent client IP spoofing.
    const forwarded = req.headers['x-forwarded-for'];
    const ip = (() => {
      if (forwarded) {
        const raw = Array.isArray(forwarded) ? forwarded[0] ?? '' : forwarded;
        const ips = raw.split(',').map((s: string) => s.trim());
        return ips[ips.length - 1] || req.socket.remoteAddress || 'unknown';
      }
      return req.socket.remoteAddress || 'unknown';
    })();
    const limited = checkRateLimit(`admin:${ip}`, { windowMs: 60000, maxRequests: 30 });
    if (limited) {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
      });
      return;
    }
    return handler(req as AuthenticatedNextApiRequest, res);
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const errorWrapped = withErrorHandler(rateLimitedHandler as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const roleWrapped = withRole('super_admin')(errorWrapped as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return withAuth(roleWrapped as any) as NextApiHandler;
}
