/**
 * POST /api/accounting/capture/[id]/discard
 * Discard a capture event with an optional reason.
 * Body: { reason?: string }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';

type Row = Record<string, unknown>;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const eventId = req.query.id as string;
  const { reason } = (req.body ?? {}) as { reason?: string };

  if (!eventId) return apiResponse.badRequest(res, 'eventId is required');

  const existing = await sql`
    SELECT id, status FROM capture_events
    WHERE id = ${eventId}::uuid AND company_id = ${companyId}
    LIMIT 1
  ` as Row[];

  if (existing.length === 0) {
    return apiResponse.notFound(res, 'Capture event', eventId);
  }

  if (existing[0]!.status === 'posted') {
    return apiResponse.badRequest(res, 'Cannot discard an already-posted event');
  }

  await sql`
    UPDATE capture_events
    SET status = 'discarded',
        error = ${reason ?? null},
        updated_at = NOW()
    WHERE id = ${eventId}::uuid AND company_id = ${companyId}
  `;

  log.info('Capture event discarded', { eventId, companyId, reason }, 'capture-discard');

  return apiResponse.success(res, { eventId, status: 'discarded' });
}

export default withAuth(withErrorHandler(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0])));
