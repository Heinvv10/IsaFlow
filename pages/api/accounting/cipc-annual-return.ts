/**
 * GET   /api/accounting/cipc-annual-return → current company's CIPC annual
 *       return submission flag, read by the CIPC Filing Guide checklist.
 * PATCH body { submitted: boolean }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { fmtDate } from '@/lib/fmtDate';

type Row = Record<string, unknown>;
interface PatchBody {
  submitted?: boolean;
}

function mapRow(row: Row) {
  return {
    submitted: Boolean(row.cipc_annual_return_submitted),
    submittedAt: row.cipc_annual_return_submitted_at ? fmtDate(row.cipc_annual_return_submitted_at) : null,
  };
}

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT cipc_annual_return_submitted, cipc_annual_return_submitted_at
      FROM companies
      WHERE id = ${companyId}::uuid
      LIMIT 1
    `) as Row[];
    const row = rows[0];
    if (!row) return apiResponse.notFound(res, 'Company', companyId);
    return apiResponse.success(res, mapRow(row));
  }

  if (req.method === 'PATCH') {
    const body = (req.body ?? {}) as PatchBody;
    if (typeof body.submitted !== 'boolean') {
      return apiResponse.badRequest(res, 'submitted (boolean) is required');
    }

    const rows = (await sql`
      UPDATE companies SET
        cipc_annual_return_submitted    = ${body.submitted},
        cipc_annual_return_submitted_at = ${body.submitted ? sql`NOW()` : null},
        updated_at                      = NOW()
      WHERE id = ${companyId}::uuid
      RETURNING cipc_annual_return_submitted, cipc_annual_return_submitted_at
    `) as Row[];

    const row = rows[0];
    if (!row) return apiResponse.notFound(res, 'Company', companyId);

    log.info('Updated CIPC annual return flag', {
      companyId,
      submitted: row.cipc_annual_return_submitted,
    }, 'cipc-annual-return');

    return apiResponse.success(res, mapRow(row));
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'PATCH']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
