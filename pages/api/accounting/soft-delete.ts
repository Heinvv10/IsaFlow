/**
 * WS-1.2: Soft Delete / Undo API
 *
 * POST /api/accounting/soft-delete
 *   Body: { entityType: string, entityId: string }
 *   Soft-deletes a non-posted entity — starts the 5-minute undo clock.
 *   Response: { undoToken: string, expiresIn: 30 }
 *
 * PUT /api/accounting/soft-delete
 *   Body: { entityType: string, entityId: string }
 *   Restores a soft-deleted entity within the undo window.
 *   Response: { restored: boolean }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  softDelete,
  undoDelete,
  isValidEntityType,
} from '@/modules/accounting/services/core/softDeleteService';

/**
 * Refusals the caller can act on, as opposed to a fault. Both the delete and
 * the undo reverse a journal through reverseJournalEntry, which refuses to
 * date a correction into a closed or missing period — the user's problem to
 * fix, not a 500. withAuth only ROLLBACKs above 4xx, so the savepoint inside
 * softDelete/undoDelete is what keeps a 400 from committing the reversal's
 * draft rows.
 */
function isUserFixable(err: unknown): err is Error {
  if (!(err instanceof Error)) return false;
  const message = err.message;
  return (
    message.includes('not found') ||
    message.includes('already deleted') ||
    message.includes('Cannot delete a posted') ||
    message.includes('with payments') ||
    message.includes('fiscal period') ||
    message.includes('No fiscal period')
  );
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyAuthedRequest;

  // ── POST: soft-delete ──────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { entityType, entityId } = req.body as {
      entityType?: string;
      entityId?: string;
    };

    if (!entityType || !entityId) {
      return apiResponse.badRequest(res, 'entityType and entityId are required');
    }
    if (!isValidEntityType(entityType)) {
      return apiResponse.badRequest(
        res,
        `entityType must be one of: customer, supplier, item, bank_rule, customer_invoice, supplier_invoice`,
      );
    }

    try {
      const result = await softDelete(companyId, entityType, entityId, user.id);
      log.info('Soft delete via API', { entityType, entityId, companyId }, 'accounting');
      return apiResponse.success(res, {
        undoToken: result.undoToken,
        expiresIn: 30,
      });
    } catch (err) {
      if (isUserFixable(err)) {
        return apiResponse.badRequest(res, (err as Error).message);
      }
      log.error('Soft delete API error', { entityType, entityId, error: err }, 'accounting');
      return apiResponse.internalError(res, err, 'Failed to delete entity');
    }
  }

  // ── PUT: undo delete ───────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const { entityType, entityId } = req.body as {
      entityType?: string;
      entityId?: string;
    };

    if (!entityType || !entityId) {
      return apiResponse.badRequest(res, 'entityType and entityId are required');
    }
    if (!isValidEntityType(entityType)) {
      return apiResponse.badRequest(
        res,
        `entityType must be one of: customer, supplier, item, bank_rule, customer_invoice, supplier_invoice`,
      );
    }

    try {
      const restored = await undoDelete(companyId, entityType, entityId, user.id);
      log.info('Undo delete via API', { entityType, entityId, restored, companyId }, 'accounting');
      return apiResponse.success(res, { restored });
    } catch (err) {
      // Same mapping as the delete path: the undo re-instates the journal
      // through the same reverseJournalEntry, so a period closed between the
      // delete and the undo is an ordinary, user-fixable refusal, not a 500.
      if (isUserFixable(err)) {
        return apiResponse.badRequest(res, (err as Error).message);
      }
      log.error('Undo delete API error', { entityType, entityId, error: err }, 'accounting');
      return apiResponse.internalError(res, err, 'Failed to restore entity');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['POST', 'PUT']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
