/**
 * Mark notifications read (budgets P5 spec §4): POST { ids: uuid[] (1-100) } or { all: true }
 *   → { updated }: how many of the caller's OWN unread rows were marked. Another member's id, or
 * one already read, is ignored (never an error, never a hint that it exists).
 * Any member (marking your own bell read is not a data write): CSRF-checked, no write-role gate.
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { MAX_MARK_READ_IDS, markRead } from '@/modules/accounting/services/notifications/userNotificationService';

const ReadSchema = z.union([
  z.object({ ids: z.array(UUID).min(1).max(MAX_MARK_READ_IDS) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const parsed = ReadSchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  return apiResponse.success(res, await markRead(companyId, userId, parsed.data));
}

export default withAuth(withErrorHandler(withCsrf(handler)));
