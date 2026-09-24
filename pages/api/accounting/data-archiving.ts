/**
 * Data Archiving API
 * WS-7.4 — Storage stats, preview, validation, and archive execution.
 *
 * GET  /api/accounting/data-archiving              → storage stats
 * GET  /api/accounting/data-archiving?action=preview&cutoff=YYYY-MM-DD
 * GET  /api/accounting/data-archiving?action=validate&cutoff=YYYY-MM-DD
 * POST /api/accounting/data-archiving              → refused: archiving is switched off
 *
 * Executing an archive is SWITCHED OFF (2026-09-24, Hein). `executeArchive`
 * deletes pre-cutoff posted journals, reconciled bank lines and settled
 * invoices, and no report reads the archive tables, so every trial balance,
 * balance sheet and VAT201 before the cutoff would lose that history. Bring it
 * back only with a design that keeps the reports whole (e.g. closing-balance
 * roll-forward journals); see core/.claude.md.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getStorageStats,
  previewArchive,
  validateArchive,
} from '@/modules/accounting/services/core/dataArchivingService';

const COMPONENT = 'data-archiving-api';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ARCHIVING_OFF =
  'Archiving is switched off. It deletes posted journals, and the reports do not read the archive, '
  + 'so every trial balance, balance sheet and VAT return before the cutoff would change.';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyAuthedRequest;
  const { companyId, companyRole } = companyReq;
  const userId = (companyReq as unknown as { user: { id: string } }).user?.id ?? '';

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const { action, cutoff } = req.query;

    // Stats (default)
    if (!action) {
      try {
        const stats = await getStorageStats(companyId);
        return apiResponse.success(res, { stats });
      } catch (err) {
        log.error('Failed to get storage stats', { companyId, error: err }, COMPONENT);
        return apiResponse.badRequest(res, 'Failed to retrieve storage statistics');
      }
    }

    // Preview or Validate both require a cutoff date
    if (action === 'preview' || action === 'validate') {
      if (!cutoff || typeof cutoff !== 'string' || !DATE_RE.test(cutoff)) {
        return apiResponse.badRequest(res, 'cutoff parameter must be a valid date (YYYY-MM-DD)');
      }

      if (action === 'preview') {
        try {
          const preview = await previewArchive(companyId, cutoff);
          return apiResponse.success(res, { preview });
        } catch (err) {
          log.error('Failed to preview archive', { companyId, cutoff, error: err }, COMPONENT);
          return apiResponse.badRequest(res, 'Failed to generate archive preview');
        }
      }

      // action === 'validate'
      try {
        const validation = await validateArchive(companyId, cutoff);
        return apiResponse.success(res, { validation });
      } catch (err) {
        log.error('Failed to validate archive', { companyId, cutoff, error: err }, COMPONENT);
        return apiResponse.badRequest(res, 'Failed to validate archive');
      }
    }

    return apiResponse.badRequest(res, `Unknown action: ${String(action)}`);
  }

  // ── POST — execute archive: switched off ──────────────────────────────────
  if (req.method === 'POST') {
    log.warn('Archive execution refused: archiving is switched off', { companyId, userId, companyRole }, COMPONENT);
    return apiResponse.forbidden(res, ARCHIVING_OFF);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
