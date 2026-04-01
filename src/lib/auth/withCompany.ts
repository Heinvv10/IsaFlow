/**
 * Company-scoped authentication middleware.
 * Wraps withAuth and adds company context from X-Company-Id header
 * or the user's default company.
 */

import type { NextApiRequest, NextApiResponse, NextApiHandler } from 'next';
import { sql } from '@/lib/neon';
import { withAuth, type AuthenticatedNextApiRequest } from './middleware';
import { log } from '@/lib/logger';

export interface CompanyApiRequest extends AuthenticatedNextApiRequest {
  companyId: string;
  companyRole: string;
}

// Accept handlers that declare a more specific req type (e.g. CompanyApiRequest,
// AuthenticatedNextApiRequest) — the cast inside withCompany is safe because
// by the time handler is called, the request has been enriched with those fields.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CompanyHandler = (req: any, res: NextApiResponse<any>) => any;

/**
 * Middleware that requires authentication AND resolves the active company.
 *
 * Company resolution order:
 * 1. X-Company-Id request header (set by frontend CompanyContext)
 * 2. User's default company (is_default = true in company_users)
 * 3. First company the user belongs to
 *
 * Attaches companyId and companyRole to the request object.
 */
export function withCompany(handler: CompanyHandler): NextApiHandler {
  return withAuth(async (req: NextApiRequest, res: NextApiResponse) => {
    try {
      const authReq = req as AuthenticatedNextApiRequest;
      const userId = authReq.user.id;

      // 1. Try X-Company-Id header
      const companyId = req.headers['x-company-id'] as string | undefined;

      if (companyId) {
        // Validate user has access to this specific company
        const access = await sql`
          SELECT role FROM company_users
          WHERE user_id = ${userId} AND company_id = ${companyId}::UUID
          LIMIT 1
        `;

        if (access.length === 0) {
          return res.status(403).json({
            success: false,
            error: { code: 'FORBIDDEN', message: 'You do not have access to this company' },
          });
        }

        (req as CompanyApiRequest).companyId = companyId;
        (req as CompanyApiRequest).companyRole = access[0]!.role as string;
        return handler(req, res);
      }

      // 2. Fall back to user's default or first company
      const companies = await sql`
        SELECT company_id, role, is_default
        FROM company_users
        WHERE user_id = ${userId}
        ORDER BY is_default DESC, created_at ASC
        LIMIT 1
      `;

      if (companies.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_COMPANY', message: 'No company assigned. Please contact an administrator.' },
        });
      }

      (req as CompanyApiRequest).companyId = companies[0]!.company_id as string;
      (req as CompanyApiRequest).companyRole = companies[0]!.role as string;
      return handler(req, res);
    } catch (error) {
      log.error('Company middleware error', error instanceof Error ? { message: error.message } : { error }, 'CompanyMiddleware');
      return res.status(500).json({
        success: false,
        error: { code: 'COMPANY_ERROR', message: 'Failed to resolve company context' },
      });
    }
  });
}
