/**
 * Migration Validation API
 * GET /api/accounting/migration/validate?sessionId=xxx
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { validateMigration } from '@/modules/accounting/services/migrationValidationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const { companyId } = req as CompanyApiRequest;
  const sessionId = String(req.query.sessionId || '').trim();

  if (!sessionId) {
    return apiResponse.validationError(res, { sessionId: 'sessionId query parameter is required' });
  }

  const results = await validateMigration(companyId, sessionId);

  const failCount = results.filter(r => r.status === 'fail').length;
  const warnCount = results.filter(r => r.status === 'warn').length;
  const passCount = results.filter(r => r.status === 'pass').length;

  log.info('Migration validation run', {
    companyId,
    sessionId,
    pass: passCount,
    warn: warnCount,
    fail: failCount,
  }, 'migration');

  // Transform to shape expected by validate.tsx UI
  const checks = results.map((r, i) => ({
    id: `check-${i}`,
    label: r.check,
    passed: r.status !== 'fail',
    detail: r.message + (r.detail ? ` — ${r.detail}` : ''),
  }));

  return apiResponse.success(res, {
    sessionId,
    checks,
    allPassed: failCount === 0,
    summary: { pass: passCount, warn: warnCount, fail: failCount },
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
