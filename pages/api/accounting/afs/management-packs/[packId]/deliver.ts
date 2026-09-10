// pages/api/accounting/afs/management-packs/[packId]/deliver.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import { deliverPack, PackDeliveryWithheldError } from '@/modules/accounting/services/afs/packDeliveryService';

type Row = DbRow;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const packId = String(req.query.packId);

  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST']);
  }

  // IDOR guard: always filter by company_id
  const docRows = (await sql`
    SELECT id, status, delivery_withheld_reason FROM afs_documents
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

  // Defence in depth: deliverPack is the gate (every caller passes through it), and this check
  // spares the round trip.
  const withheld = docRows[0]?.delivery_withheld_reason as string | null;
  if (withheld) {
    return apiResponse.conflict(res, withheld);
  }

  log.info('Manual pack delivery triggered', { companyId, packId, status }, 'management-pack-deliver-api');

  try {
    await deliverPack(packId, companyId);
  } catch (err) {
    if (err instanceof PackDeliveryWithheldError) return apiResponse.conflict(res, err.message);
    throw err;
  }

  return apiResponse.success(res, { delivered: true });
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
