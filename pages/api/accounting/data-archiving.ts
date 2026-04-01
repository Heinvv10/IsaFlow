/**
 * Data Archiving API
 * WS-7.4 — Storage stats, preview, validation, and archive execution.
 *
 * GET  /api/accounting/data-archiving              → storage stats
 * GET  /api/accounting/data-archiving?action=preview&cutoff=YYYY-MM-DD
 * GET  /api/accounting/data-archiving?action=validate&cutoff=YYYY-MM-DD
 * POST /api/accounting/data-archiving              → execute archive (admin/owner only)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getStorageStats,
  previewArchive,
  validateArchive,
  executeArchive,
} from '@/modules/accounting/services/dataArchivingService';

const COMPONENT = 'data-archiving-api';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyApiRequest;
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

  // ── POST — execute archive ────────────────────────────────────────────────
  if (req.method === 'POST') {
    // Only owners and admins may execute an archive
    if (companyRole !== 'owner' && companyRole !== 'admin') {
      return apiResponse.badRequest(res, 'Only company owners or admins may execute data archiving');
    }

    const { cutoffDate } = req.body as { cutoffDate?: string };
    if (!cutoffDate || typeof cutoffDate !== 'string' || !DATE_RE.test(cutoffDate)) {
      return apiResponse.badRequest(res, 'cutoffDate must be a valid date (YYYY-MM-DD)');
    }

    // Validate before executing
    const validation = await validateArchive(companyId, cutoffDate);
    if (!validation.valid) {
      return apiResponse.badRequest(res, `Archive validation failed: ${validation.errors.join('; ')}`);
    }

    try {
      log.info('Executing archive', { companyId, cutoffDate, userId }, COMPONENT);
      const result = await executeArchive(companyId, cutoffDate, userId);
      return apiResponse.success(res, { result });
    } catch (err) {
      log.error('Archive execution failed', { companyId, cutoffDate, error: err }, COMPONENT);
      return apiResponse.badRequest(res, 'Archive execution failed. All changes have been rolled back.');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
