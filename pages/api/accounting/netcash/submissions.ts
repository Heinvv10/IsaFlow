/**
 * GET /api/accounting/netcash/submissions
 * List Netcash submissions for the company with optional status filter.
 * Query params: status, limit, offset
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return apiResponse.methodNotAllowed(res, req.method!, ['GET']);

  const { companyId } = req;
  const { status, limit = '50', offset = '0' } = req.query;
  const limitNum = Math.min(Number(limit), 200);
  const offsetNum = Number(offset);

  let rows: Row[];
  if (status) {
    rows = await sql`
      SELECT id, submission_type, batch_reference, total_amount_cents,
             record_count, status, submitted_at, created_at, created_by,
             netcash_response
      FROM netcash_submissions
      WHERE company_id = ${companyId}::UUID AND status = ${String(status)}
      ORDER BY created_at DESC
      LIMIT ${limitNum} OFFSET ${offsetNum}
    ` as Row[];
  } else {
    rows = await sql`
      SELECT id, submission_type, batch_reference, total_amount_cents,
             record_count, status, submitted_at, created_at, created_by,
             netcash_response
      FROM netcash_submissions
      WHERE company_id = ${companyId}::UUID
      ORDER BY created_at DESC
      LIMIT ${limitNum} OFFSET ${offsetNum}
    ` as Row[];
  }

  const countRows = status
    ? await sql`SELECT COUNT(*) AS total FROM netcash_submissions WHERE company_id = ${companyId}::UUID AND status = ${String(status)}` as Row[]
    : await sql`SELECT COUNT(*) AS total FROM netcash_submissions WHERE company_id = ${companyId}::UUID` as Row[];

  return apiResponse.success(res, {
    items: rows,
    total: Number(countRows[0]?.total ?? 0),
    limit: limitNum,
    offset: offsetNum,
  });
}

export default withCompany(withErrorHandler(handler as Parameters<typeof withCompany>[0]));
