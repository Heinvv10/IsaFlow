// pages/api/accounting/afs/management-packs/[packId]/deliver.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { deliverPack } from '@/modules/accounting/services/afs/packDeliveryService';

type Row = DbRow;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;
  const packId = String(req.query.packId);

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  // IDOR guard: always filter by company_id
  const docRows = (await sql`
    SELECT id, status FROM afs_documents
    WHERE id = ${packId}::UUID
      AND company_id = ${companyId}::UUID
      AND document_type = 'management_pack'
  `) as Row[];

  if (docRows.length === 0) {
    return apiResponse.notFound(res, 'Management pack', packId);
  }

  const status = String(docRows[0]?.status ?? '');
  if (status !== 'draft' && status !== 'signed_off') {
    return apiResponse.badRequest(res, `Cannot deliver pack with status '${status}'`);
  }

  log.info('Manual pack delivery triggered', { companyId, packId, status }, 'management-pack-deliver-api');

  await deliverPack(packId, companyId);

  return apiResponse.success(res, { delivered: true });
}

export default withCompany(withErrorHandler(handler as never));
