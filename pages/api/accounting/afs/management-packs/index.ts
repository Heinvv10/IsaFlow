// pages/api/accounting/afs/management-packs/index.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

type Row = DbRow;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const year = req.query.year ? Number(req.query.year) : null;

  log.info('Listing management packs', { companyId, year }, 'management-packs-api');

  let rows: Row[];
  if (year && Number.isFinite(year)) {
    rows = (await sql`
      SELECT * FROM afs_documents
      WHERE company_id = ${companyId}::UUID
        AND document_type = 'management_pack'
        AND period LIKE ${`${year}-%`}
      ORDER BY period DESC
    `) as Row[];
  } else {
    rows = (await sql`
      SELECT * FROM afs_documents
      WHERE company_id = ${companyId}::UUID
        AND document_type = 'management_pack'
      ORDER BY period DESC
    `) as Row[];
  }

  return apiResponse.success(res, { documents: rows });
}

export default withAuth(withErrorHandler(handler as never));
