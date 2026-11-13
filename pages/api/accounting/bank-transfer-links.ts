/**
 * GET  /api/accounting/bank-transfer-links?bankAccountId=<uuid> → { batches } (the last 90 days of automatic
 *      transfer links on that bank account, newest first; migration 978)
 * POST body { action: 'undo', batchId } | { action: 'undo', linkId } → { undone, refused }
 *      Puts the lines back exactly as they were before the link, only where nothing has changed them since.
 *      A refusal is raised before any write, so the COMMIT withAuth issues on a 4xx commits nothing.
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfLockTimeout } from '@/lib/apiDocumentLock';
import { UUID } from '@/lib/schemas/common';
import { isUuidParam } from '@/lib/validation';
import { listTransferLinks } from '@/modules/accounting/services/bank/bankTransferLinkLog';
import { TransferLinkUndoError, undoTransferLinks } from '@/modules/accounting/services/bank/bankTransferLinkUndo';
import { isRetryableContention } from '@/modules/accounting/services/core/retryableContention';

const UndoSchema = z.union([
  z.object({ action: z.literal('undo'), batchId: UUID }).strict(),
  z.object({ action: z.literal('undo'), linkId: UUID }).strict(),
]);

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    const bankAccountId = req.query.bankAccountId;
    if (!isUuidParam(bankAccountId)) return apiResponse.badRequest(res, 'bankAccountId is required');
    return apiResponse.success(res, { batches: await listTransferLinks(companyId, bankAccountId) });
  }

  if (req.method === 'POST') {
    const parsed = UndoSchema.safeParse(req.body ?? {});
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    const target = 'batchId' in parsed.data ? { batchId: parsed.data.batchId } : { linkId: parsed.data.linkId };
    try {
      const result = await undoTransferLinks(companyId, target, { id: req.user.id, email: req.user.email });
      return apiResponse.success(res, result);
    } catch (err) {
      if (err instanceof TransferLinkUndoError) {
        return err.code === 'NOT_FOUND'
          ? apiResponse.error(res, ErrorCode.NOT_FOUND, err.message)
          : apiResponse.conflict(res, err.message);
      }
      // A held row is 503 + Retry-After (D11); a retryable STATE conflict stays 409.
      if (respondIfLockTimeout(res, err)) return;
      if (isRetryableContention(err)) return apiResponse.conflict(res, (err as Error).message);
      throw err;
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? '', ['GET', 'POST']);
}

export default withAuth(
  withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))),
);
