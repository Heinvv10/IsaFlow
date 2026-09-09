/**
 * PATCH  /api/accounting/expense-claims/[id]/lines/[lineId]   update a line (draft only)
 * DELETE /api/accounting/expense-claims/[id]/lines/[lineId]   remove a line (draft only)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { sql } from '@/lib/neon';
import { claimInputVatWarnings } from '@/modules/accounting/services/expense/claimVatAdvice';
import { deleteLine, getClaim } from '@/modules/accounting/services/expense/expenseClaimService';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PatchBody {
  glAccountId?: string | null;
  costCentreId?: string | null;
  projectId?: string | null;
  description?: string | null;
  vatAmount?: number;
  vatCode?: string | null;
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const id = req.query.id as string;
  const lineId = req.query.lineId as string;
  if (!id || !UUID_RE.test(id) || !lineId || !UUID_RE.test(lineId)) {
    return apiResponse.notFound(res, 'Expense claim line', `${id}/${lineId}`);
  }

  const claim = await getClaim(id, companyId);
  if (!claim) return apiResponse.notFound(res, 'Expense claim', id);
  if (claim.status !== 'draft') {
    return apiResponse.badRequest(res, `Cannot modify lines on claim in status '${claim.status}'`);
  }

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as PatchBody;
    const rows = (await sql`
      UPDATE expense_claim_lines
      SET gl_account_id  = COALESCE(${body.glAccountId ?? null}::uuid, gl_account_id),
          cost_centre_id = COALESCE(${body.costCentreId ?? null}::uuid, cost_centre_id),
          project_id     = COALESCE(${body.projectId ?? null}::uuid, project_id),
          description    = COALESCE(${body.description ?? null}, description),
          vat_amount     = COALESCE(${body.vatAmount ?? null}, vat_amount),
          vat_code       = COALESCE(${body.vatCode ?? null}, vat_code)
      WHERE id = ${lineId}::uuid AND claim_id = ${id}::uuid AND company_id = ${companyId}::uuid
      RETURNING id
    `) as Array<{ id: string }>;
    if (rows.length === 0) return apiResponse.notFound(res, 'Expense claim line', lineId);
    const refreshed = await getClaim(id, companyId);
    // Restoring the VAT on a line coded to a flagged account is exactly the
    // edit the s17(2)(a) denial exists for, and it used to happen in silence.
    const warnings = await claimInputVatWarnings(id, companyId);
    return apiResponse.success(res, { claim: refreshed, warnings });
  }

  if (req.method === 'DELETE') {
    const refreshed = await deleteLine(lineId, id, companyId);
    return apiResponse.success(res, { claim: refreshed, warnings: await claimInputVatWarnings(id, companyId) });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['PATCH', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
