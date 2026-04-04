/**
 * Page Visits API — tracks user navigation for dynamic quick actions
 * GET  /api/accounting/page-visits?limit=6  — top visited pages for current user
 * POST /api/accounting/page-visits           — record a page visit
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import { PAGE_REGISTRY } from '@/modules/accounting/constants/pageRegistry';

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;

  if (req.method === 'GET') {
    const limit = Math.min(Number(req.query.limit) || 6, 20);

    const rows = await sql`
      SELECT page_path, visit_count, last_visited_at
      FROM page_visits
      WHERE company_id = ${companyId}::UUID
        AND user_id = ${userId}
      ORDER BY visit_count DESC, last_visited_at DESC
      LIMIT ${limit}
    `;

    return apiResponse.success(res, rows);
  }

  if (req.method === 'POST') {
    const { path } = req.body as { path?: string };

    if (!path || typeof path !== 'string') {
      return apiResponse.badRequest(res, 'path is required');
    }

    if (!PAGE_REGISTRY[path]) {
      return apiResponse.badRequest(res, 'Unknown page path');
    }

    await sql`
      INSERT INTO page_visits (company_id, user_id, page_path)
      VALUES (${companyId}::UUID, ${userId}, ${path})
      ON CONFLICT (company_id, user_id, page_path)
      DO UPDATE SET
        visit_count = page_visits.visit_count + 1,
        last_visited_at = NOW()
    `;

    return apiResponse.success(res, { recorded: true });
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler));
