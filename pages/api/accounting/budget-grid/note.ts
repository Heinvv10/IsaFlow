/**
 * Budget grid note (Budgets P2 follow-up F1)
 * PUT { versionId, glAccountId, note: string | null } → { note: string | null }
 * Sets, edits or clears (blank / null) the account's budget note for the VIEWED version's financial
 * year. A note is year-scoped: every version of that year shows it. Trimmed, at most 2 000
 * characters. Writers only (viewers 403); 404 for another company's version, 409
 * BUDGET_VERSION_LOCKED for a locked one, 400 for an account that is not the company's active leaf
 * revenue/expense account or a note too long. One audit row (entity `budget`, the version), without
 * the text. The version's token (`updatedAt`) does not move. Charged to the user's
 * `budget-note:<userId>` bucket first (120 a minute; 429 with Retry-After past it).
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { checkRateLimit } from '@/lib/rateLimit';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { setGridNote } from '@/modules/accounting/services/budgets/budgetNotes';

const NoteSchema = z.object({
  versionId: UUID,
  glAccountId: UUID,
  // The 2 000-character limit applies after trimming (the service); this only bounds the body.
  note: z.string().max(10_000).nullable(),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'PUT') return apiResponse.methodNotAllowed(res, req.method!, ['PUT']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  // As the grid save: each note write is an audit row, so a runaway client is stopped at two a second.
  if (!(await checkRateLimit(`budget-note:${userId}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many note saves; wait a minute and try again.');
  }
  const parsed = NoteSchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  try {
    return apiResponse.success(res, await setGridNote(companyId, { userId }, parsed.data));
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
