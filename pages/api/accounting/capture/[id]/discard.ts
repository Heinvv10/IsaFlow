/**
 * POST /api/accounting/capture/[id]/discard
 * Discard a capture event with an optional reason.
 * Body: { reason?: string }
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';
import {
  lockCaptureEventRow,
  CaptureEventLockedError,
} from '@/modules/accounting/services/capture/captureEventLock';

type Row = Record<string, unknown>;

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    return apiResponse.methodNotAllowed(res, req.method ?? '', ['POST']);
  }

  const { companyId } = req;
  const eventId = req.query.id as string;
  const { reason } = (req.body ?? {}) as { reason?: string };

  if (!eventId) return apiResponse.badRequest(res, 'eventId is required');

  // Discard is the THIRD writer of `capture_events.status`, and the post guard
  // READS that column. Unlocked and unpredicated, this handler's check-then-act
  // was the same shape R-058 exists to remove: a discard concurrent with a post
  // queues behind the post's row lock and lands after it, leaving a supplier
  // invoice on payables against an event the inbox shows as discarded, stamped
  // with `posted_by` / `posted_at`. So take the same row lock the post routes
  // take, and predicate the UPDATE so it cannot win that race even if the lock
  // is ever bypassed.
  let existing: DbRow | null;
  try {
    existing = await lockCaptureEventRow(companyId, eventId);
  } catch (lockErr) {
    if (lockErr instanceof CaptureEventLockedError) {
      return apiResponse.conflict(res, lockErr.message);
    }
    throw lockErr;
  }

  if (!existing) {
    return apiResponse.notFound(res, 'Capture event', eventId);
  }

  if (existing.status === 'posted') {
    return apiResponse.badRequest(res, 'Cannot discard an already-posted event');
  }

  const updated = await sql`
    UPDATE capture_events
    SET status = 'discarded',
        error = ${reason ?? null},
        updated_at = NOW()
    WHERE id = ${eventId}::uuid
      AND company_id = ${companyId}
      AND status <> 'posted'
    RETURNING id
  ` as Row[];

  if (updated.length === 0) {
    return apiResponse.badRequest(res, 'Cannot discard an already-posted event');
  }

  log.info('Capture event discarded', { eventId, companyId, reason }, 'capture-discard');

  return apiResponse.success(res, { eventId, status: 'discarded' });
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler as Parameters<typeof withWriteAccess>[0]))));
