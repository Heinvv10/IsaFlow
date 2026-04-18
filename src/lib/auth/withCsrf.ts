/**
 * CSRF double-submit-cookie enforcement wrapper (BL-22).
 *
 * Applies to non-idempotent methods (POST/PUT/PATCH/DELETE). GET/HEAD/OPTIONS
 * bypass the check so invite links and read-only flows continue to work under
 * SameSite=lax. On mismatch → 403 Forbidden with a CSRF-specific message.
 *
 * The generic `T extends NextApiHandler` lets this wrap either the raw handler
 * or the output of `withWriteAccess` (which returns a plain NextApiHandler).
 * The internal `as T` cast is scoped to this file; call-sites need no casts.
 */

import type { NextApiHandler, NextApiResponse } from 'next';
import { apiResponse } from '@/lib/apiResponse';
import { verifyCsrf } from './csrf';
import type { CompanyAuthedRequest } from './withAuth';

export type CompanyApiHandler = (req: CompanyAuthedRequest, res: NextApiResponse) => void | Promise<void>;

export function withCsrf<T extends NextApiHandler | CompanyApiHandler>(handler: T): T {
  return (async (req: Parameters<T>[0], res: NextApiResponse) => {
    const method = req.method?.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return (handler as NextApiHandler)(req, res);
    }
    if (!verifyCsrf(req)) {
      return apiResponse.forbidden(res, 'CSRF token mismatch');
    }
    return (handler as NextApiHandler)(req, res);
  }) as T;
}
