/**
 * Admin Middleware
 * Convenience wrapper: withPlatformAdmin + rate-limit + CSRF-header + error-handler.
 * All admin API routes must be wrapped with this.
 */

import { withPlatformAdmin, type PlatformAdminRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { checkRateLimit, getClientIp } from '@/lib/rateLimit';
import type { NextApiHandler, NextApiRequest, NextApiResponse } from 'next';
import { respondIfAdminRequestError } from './adminRequestErrors';

export function withAdmin(
  handler: (req: PlatformAdminRequest, res: NextApiResponse) => Promise<void>
): NextApiHandler {
  const rateLimitedHandler = async (req: NextApiRequest, res: NextApiResponse) => {
    const ip = getClientIp(req);
    const allowed = await checkRateLimit(`admin:${ip}`, { max: 120, windowSecs: 60 });
    if (!allowed) {
      res.status(429).json({
        success: false,
        error: { code: 'RATE_LIMITED', message: 'Too many requests. Please try again later.' },
      });
      return;
    }

    // F-04: CSRF mitigation — require a custom request header on mutating methods.
    if (req.method !== 'GET' && req.headers['x-admin-request'] !== 'true') {
      res.status(403).json({ error: 'Missing required header: X-Admin-Request' });
      return;
    }

    // A known refusal (AdminRequestError, a Postgres integrity refusal) is the route's 4xx; anything else
    // propagates to withErrorHandler's 500, which withPlatformAdmin rolls back (adminRequestErrors.ts).
    try {
      return await handler(req as PlatformAdminRequest, res);
    } catch (err) {
      if (respondIfAdminRequestError(res, err)) return;
      throw err;
    }
  };
  const errorWrapped = withErrorHandler(rateLimitedHandler);
  return withPlatformAdmin(errorWrapped) as NextApiHandler;
}
