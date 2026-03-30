/**
 * Admin Middleware
 * Convenience wrapper: withAuth + withRole('super_admin') + withErrorHandler
 * All admin API routes must be wrapped with this.
 */

import { withAuth, withRole, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import type { NextApiHandler, NextApiResponse } from 'next';

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
  return withAuth(
    withRole('super_admin')(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (async (req: AuthenticatedNextApiRequest, res: NextApiResponse) => {
        return withErrorHandler(handler as any)(req, res);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ) as any
  ) as NextApiHandler;
}
