/**
 * POST /api/accounting/eft-file-release
 * Say that the bank file(s) generated for a batch were not used, so the batch may go to Netcash (AP-01).
 * Body: { batchId: string; reason: string }. Owner/admin only. Records a release in the audit trail
 * (services/ap/batchBankFileRecord); a file generated afterwards blocks Netcash again.
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { assertNotImpersonating } from '@/lib/auth/impersonationGuard';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { releaseBankFiles } from '@/modules/accounting/services/ap/batchBankFileRecord';

type Row = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_REASON = 500;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  await assertNotImpersonating(); // R-032 L5: first, before any read or write

  const { batchId, reason } = (req.body ?? {}) as Record<string, unknown>;
  if (typeof batchId !== 'string' || !UUID.test(batchId)) return apiResponse.badRequest(res, 'batchId must be a batch id');
  const why = typeof reason === 'string' ? reason.trim() : '';
  if (why === '' || why.length > MAX_REASON) {
    return apiResponse.badRequest(res, `reason is required (why the bank file was not used), at most ${MAX_REASON} characters`);
  }

  // The batch row first, FOR NO KEY UPDATE: the order eft-generate takes it in, and it waits for a netcash/submit in flight.
  const batch = (await sql`
    SELECT id, batch_number FROM supplier_payment_batches
    WHERE id = ${batchId}::UUID AND company_id = ${req.companyId}::UUID
    FOR NO KEY UPDATE
  ` as Row[])[0];
  if (!batch) return apiResponse.notFound(res, 'Batch', batchId);

  const released = await releaseBankFiles({
    companyId: req.companyId, batchId, batchNumber: String(batch.batch_number ?? ''), reason: why,
    userId: req.user.id, userEmail: req.user.email,
  });
  if (released === 0) {
    return apiResponse.conflict(res, 'No bank file has been generated for this batch, or every one is already released.',
      { reason: 'NO_BANK_FILE_TO_RELEASE' });
  }
  log.info('Bank file released', { batchId, released, userId: req.user.id }, 'accounting');
  return apiResponse.success(res, { batchId, released });
}

// Owner/admin only: releasing a file lets the batch be paid through Netcash as well.
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withAuth>[0], { allowedRoles: ['owner', 'admin'] }))));
