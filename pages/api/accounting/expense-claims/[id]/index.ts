/**
 * /api/accounting/expense-claims/[id]
 *   GET    — claim + lines
 *   POST   — add a line (draft only)
 *   DELETE — hard-delete the claim (cascades lines)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';
import {
  getClaim,
  addLine,
  type ExpenseClaimLine,
} from '@/modules/accounting/services/expense/expenseClaimService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const id = req.query.id as string;
  if (!id || !UUID_RE.test(id)) return apiResponse.notFound(res, 'Expense claim', id);

  if (req.method === 'GET') {
    const claim = await getClaim(id, companyId);
    if (!claim) return apiResponse.notFound(res, 'Expense claim', id);
    return apiResponse.success(res, { claim });
  }

  if (req.method === 'POST') {
    const line = req.body as ExpenseClaimLine;
    if (!line.lineDate || !line.amount) {
      return apiResponse.badRequest(res, 'lineDate and amount are required');
    }
    try {
      const claim = await addLine(id, companyId, line);
      if (!claim) return apiResponse.notFound(res, 'Expense claim', id);
      return apiResponse.success(res, { claim });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return apiResponse.badRequest(res, msg);
    }
  }

  if (req.method === 'DELETE') {
    const rows = (await sql`
      DELETE FROM expense_claims
      WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
        AND status IN ('draft', 'cancelled', 'rejected')
      RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) {
      return apiResponse.badRequest(res, 'Claim not found or not deletable (must be draft/cancelled/rejected)');
    }
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST', 'DELETE']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
