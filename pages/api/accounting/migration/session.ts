/**
 * Migration Session API
 * GET  /api/accounting/migration/session — active in-progress session for company
 * POST /api/accounting/migration/session — create new session { sourceSystem }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess} from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import { createSession, completeSession, mapSessionRow } from '@/modules/accounting/services/core/migrationService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const rows = await sql`
      SELECT * FROM migration_sessions
      WHERE company_id = ${companyId}::UUID AND status = 'in_progress'
      ORDER BY started_at DESC
      LIMIT 1
    `;

    if (rows.length === 0) {
      return apiResponse.success(res, { session: null });
    }

    return apiResponse.success(res, { session: mapSessionRow(rows[0]!) });
  }

  if (req.method === 'POST') {
    const userId = (req as AuthenticatedNextApiRequest).user.id;
    const { sourceSystem, sessionId, action } = req.body as {
      sourceSystem?: string;
      sessionId?: string;
      action?: string;
    };

    // Handle "complete" action — mark session as completed
    if (action === 'complete' && sessionId) {
      const session = await completeSession(sessionId, companyId);
      log.info('Migration session completed', { companyId, sessionId }, 'migration');
      return apiResponse.success(res, { session });
    }

    // Default: create a new session
    if (!sourceSystem?.trim()) {
      return apiResponse.validationError(res, { sourceSystem: 'Source system is required' });
    }

    const session = await createSession(companyId, sourceSystem, userId);
    log.info('Migration session started', { companyId, sourceSystem, sessionId: session.id }, 'migration');
    return apiResponse.created(res, { session }, 'Migration session created');
  }

  return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET', 'POST']);
}

 
export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
