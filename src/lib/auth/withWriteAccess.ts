/**
 * Write-access gate — requires owner/admin/manager role for mutating methods.
 *
 * Wraps a handler that has already been enriched by withCompany (so
 * `req.companyRole` is populated). For any POST/PUT/PATCH/DELETE request
 * where the caller's per-company role is NOT owner/admin/manager (i.e. it's
 * "viewer" or some unknown future read-only role), returns 403 before the
 * handler runs. GET/HEAD/OPTIONS pass through unchanged.
 *
 * Usage:
 *   export default withCompany(withErrorHandler(withWriteAccess(handler)));
 *
 * Defaults apply to the vast majority of accounting endpoints. For a
 * stricter gate (e.g. "admins only") pass `{ allowedRoles: [...] }`.
 * For a looser gate (e.g. allowing viewers to save their own preferences)
 * pass `{ allowedRoles: null }` to disable this layer entirely — it's
 * explicit so a grep finds every exception.
 */

import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import type { CompanyApiRequest } from './withCompany';

const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const DEFAULT_WRITE_ROLES = ['owner', 'admin', 'manager'] as const;

export type WriteRole = (typeof DEFAULT_WRITE_ROLES)[number];

interface WithWriteAccessOptions {
  /**
   * Roles allowed to mutate. Default: ['owner', 'admin', 'manager'].
   * Set to `null` to disable the gate for a specific endpoint (e.g. user
   * preferences where a viewer should be able to save their own state).
   */
  allowedRoles?: readonly string[] | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Handler = (req: any, res: NextApiResponse<any>) => unknown | Promise<unknown>;

export function withWriteAccess(
  handler: Handler,
  options: WithWriteAccessOptions = {},
): NextApiHandler {
  const allowed = options.allowedRoles === undefined ? DEFAULT_WRITE_ROLES : options.allowedRoles;

  return async (req: NextApiRequest, res: NextApiResponse) => {
    // Explicit opt-out: allowedRoles: null → no gate.
    if (allowed === null) {
      return handler(req, res);
    }

    // Read-only methods always pass through.
    const method = (req.method ?? 'GET').toUpperCase();
    if (!WRITE_METHODS.has(method)) {
      return handler(req, res);
    }

    const companyReq = req as CompanyApiRequest;
    const role = companyReq.companyRole;

    // If withCompany didn't run first (misuse), fail closed.
    if (!role) {
      return apiResponse.forbidden(
        res,
        'Write access check failed: no company role on request.',
      );
    }

    if (!allowed.includes(role)) {
      return apiResponse.forbidden(
        res,
        `Your role (${role}) does not allow this action.`,
      );
    }

    return handler(req, res);
  };
}
