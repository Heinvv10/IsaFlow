/**
 * SARS calendar "marked filed"
 * POST   { eventType, periodEnd, sarsReference? } — mark the item filed (201; 409 when already marked)
 * DELETE { eventType, periodEnd }                 — undo the mark (200; 404 when not marked)
 * Write roles only; a Login-as session is refused (403). One audit row per mark and per undo.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { respondIfImpersonationForbidden } from '@/lib/auth/impersonationGuard';
import { isRealCalendarDate } from '@/lib/validation';
import {
  AlreadyMarkedFiledError, CalendarItemNotFoundError, MARKABLE_EVENT_TYPES, NotMarkedFiledError,
  markFiled, unmarkFiled,
} from '@/modules/accounting/services/reports/sarsFiledMarks';

const Key = z.object({
  eventType: z.enum(MARKABLE_EVENT_TYPES),
  periodEnd: z.string().refine(isRealCalendarDate, 'periodEnd must be a valid date (YYYY-MM-DD)'),
});
const Mark = Key.extend({
  sarsReference: z.string().trim().max(100, 'The SARS reference is at most 100 characters').nullish(),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  if (req.method !== 'POST' && req.method !== 'DELETE') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['POST', 'DELETE']);
  }
  const parsed = (req.method === 'POST' ? Mark : Key).safeParse(req.body ?? {});
  if (!parsed.success) return apiResponse.badRequest(res, parsed.error.issues[0]?.message ?? 'Invalid request');

  try {
    if (req.method === 'POST') {
      const mark = await markFiled(companyId, userId, parsed.data);
      return apiResponse.created(res, mark, 'Marked filed');
    }
    await unmarkFiled(companyId, userId, parsed.data);
    return apiResponse.success(res, { eventType: parsed.data.eventType, periodEnd: parsed.data.periodEnd }, 'Mark removed');
  } catch (err) {
    if (respondIfImpersonationForbidden(res, err)) return;
    if (err instanceof AlreadyMarkedFiledError) return apiResponse.conflict(res, err.message);
    if (err instanceof CalendarItemNotFoundError || err instanceof NotMarkedFiledError) return apiResponse.error(res, ErrorCode.NOT_FOUND, err.message);
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
