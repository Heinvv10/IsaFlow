// pages/api/accounting/afs/management-packs/[packId]/index.ts
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
  const packId = String(req.query.packId);

  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  log.info('Fetching management pack', { companyId, packId }, 'management-pack-detail-api');

  // IDOR guard: always filter by company_id
  const docRows = (await sql`
    SELECT * FROM afs_documents
    WHERE id = ${packId}::UUID
      AND company_id = ${companyId}::UUID
      AND document_type = 'management_pack'
  `) as Row[];

  if (docRows.length === 0) {
    return apiResponse.notFound(res, 'Management pack', packId);
  }

  const sectionRows = (await sql`
    SELECT * FROM afs_sections
    WHERE document_id = ${packId}::UUID
      AND company_id = ${companyId}::UUID
    ORDER BY sort_order ASC
  `) as Row[];

  return apiResponse.success(res, {
    document: docRows[0],
    sections: sectionRows,
  });
}

export default withAuth(withErrorHandler(handler as never));
