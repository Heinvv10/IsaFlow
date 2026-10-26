/**
 * Budget grid batch save (Budgets P2, spec §7.2)
 * POST { versionId, expectedUpdatedAt, cells: [{ glAccountId, cc1Id, cc2Id, buId, month: 'YYYY-MM', amount } | { …, amount: null, clear: true }] }
 *   → { updatedAt, saved, deleted }
 * `amount: null, clear: true` deletes the cell; a null without `clear: true`, or `clear: true` with an
 * amount, is a 400 naming the cell. One batch, one transaction, one audit row. 400 for a bad batch
 * (an account or dimension not the company's, a header or inactive account without amounts in the
 * version, a month outside its year, a grain clash), 404 for another company's version, 409
 * BUDGET_VERSION_LOCKED / BUDGET_VERSION_STALE (with `currentUpdatedAt` and `status`). Every
 * refusal leaves the version, its amounts and its token as they were. The Excel import commits here.
 * Next's own body parser reads the JSON (at most 4 MB: 413 past it); one request carries at most
 * MAX_SAVE_CELLS (20 000) cells, so a bigger commit (an import of up to MAX_IMPORT_CELLS) is
 * CHAINED by the client, each chunk sent with the token the previous save returned. Each save is
 * charged to the user's bucket first (120 a minute; 429 with Retry-After past it).
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { checkRateLimit } from '@/lib/rateLimit';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { BudgetVersionStaleError, MAX_SAVE_CELLS, saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { isVersionToken } from '@/modules/accounting/services/budgets/gridErrors';

/**
 * Next's body parser, like every other route (it reads before withAuth, so it never holds a pooled
 * connection). 4 MB holds MAX_SAVE_CELLS of the widest valid cell (~172 bytes each, ~3.4 MB), pinned
 * by tests/unit/api/budgetGridSaveLimits.test.ts.
 */
export const config = { api: { bodyParser: { sizeLimit: '4mb' } } };

const SaveSchema = z.object({
  versionId: UUID,
  // A real timestamp, checked here: one Postgres cannot read (30 February, offset +99) would be a 500 at the compare.
  expectedUpdatedAt: z.string().max(40).refine(isVersionToken, 'expectedUpdatedAt must be the updatedAt the version was read with'),
  cells: z.array(z.object({
    glAccountId: UUID,
    cc1Id: UUID.nullable().default(null),
    cc2Id: UUID.nullable().default(null),
    buId: UUID.nullable().default(null),
    month: z.string().max(7),
    amount: z.number().nullable(),
    // Delete is explicit: NaN or Infinity in a client serialises to null, which must not delete.
    clear: z.boolean().optional(),
  })).max(MAX_SAVE_CELLS),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  // 120 saves a minute is two a second, sustained: well above a person editing the grid or a chained import.
  if (!(await checkRateLimit(`budget-save:${userId}`, { max: 120, windowSecs: 60 }))) {
    res.setHeader('Retry-After', '60');
    return apiResponse.tooManyRequests(res, 'Too many budget saves; wait a minute and try again.');
  }
  const parsed = SaveSchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  try {
    return apiResponse.success(res, await saveCells(companyId, userId, parsed.data));
  } catch (err) {
    if (err instanceof BudgetVersionStaleError) {
      return apiResponse.error(res, ErrorCode.CONFLICT, err.message,
        { code: err.code, currentUpdatedAt: err.currentUpdatedAt, status: err.versionStatus });
    }
    if (respondBudgetVersionError(res, err)) return;
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
