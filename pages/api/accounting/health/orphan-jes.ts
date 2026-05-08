/**
 * Orphan Journal Entries health check.
 *
 * GET /api/accounting/health/orphan-jes?limit=100
 *
 * Returns posted JEs whose entry_date doesn't fall inside any fiscal_periods
 * row for the current company. Read-only diagnostic; surfaces the integrity
 * violation that bit Brightsphere on 2026-05-08 (5 auto_bank_recon JEs from
 * 2022 that snuck in before PR #111 added the period pre-flight).
 *
 * Tenant-scoped via withAuth — every caller only ever sees their own
 * company's orphans.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { findOrphanJournalEntries } from '@/modules/accounting/services/gl/glIntegrityService';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyAuthedRequest;

  const rawLimit = Number(req.query.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
    : DEFAULT_LIMIT;

  try {
    const result = await findOrphanJournalEntries(companyId, limit);
    return apiResponse.success(res, result);
  } catch (err) {
    log.error('Failed to find orphan journal entries', { error: err, companyId }, 'accounting-api');
    return apiResponse.badRequest(res, 'Failed to run orphan-JE health check');
  }
}

export default withAuth(withErrorHandler(handler));
