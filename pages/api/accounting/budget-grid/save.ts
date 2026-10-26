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
 * The body is read before the transaction opens: at most 18 MB (413); within 15 s (up to 64 KB),
 * 30 s (up to 1 MB) or 290 s, no pause over 10 s, and a large body at 16 KB/s or more after 10 s
 * (400 REQUEST_BODY_TIMEOUT); at most MAX_SAVE_CELLS cells.
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
import { JsonBodyError, respondBodyError, takeJsonBody, withBodyFirst, type BodyLimits } from '@/lib/readJsonBody';

// The route reads the body itself (withBodyFirst, before withAuth opens the transaction, for a
// CSRF-checked caller with a signed session): Next's parser would buffer and parse it for any
// caller, and withErrorHandler would log it (round-2 SEC2-M2, M3; round-3 slow-body hold).
export const config = { api: { bodyParser: false } };

/**
 * MAX_SAVE_CELLS (100 000) cells of compact JSON are at most ~17.2 MB (172 bytes for the widest
 * cell), so 18 MB, the same as one user's early-read budget. 290 s in all for a large body, under
 * Node's 300 s request timeout: 512 kbit/s ADSL sends 62.5 KiB/s, so 17.2 MB takes ~269 s (~282 s
 * if read as 17.2 MiB). A normal
 * save is a few KB: readRawBody's tiny tier, 15 s. 10 s idle tolerates a weak-LTE stall. What a slow
 * sender holds meanwhile is only the bytes it has sent (readJsonBody's lanes).
 */
export const SAVE_BODY_LIMITS: BodyLimits = { maxBytes: 18 * 1048576, totalMs: 290_000, idleMs: 10_000 };

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
  let body: unknown;
  try {
    body = await takeJsonBody(req);
  } catch (err) {
    if (!(err instanceof JsonBodyError)) throw err;
    return respondBodyError(res, err);
  }
  const parsed = SaveSchema.safeParse(body);
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

/**
 * Charged per user before the body is read: 120 saves a minute is two a second, sustained, well above
 * a person editing the grid (the page saves on blur / every few seconds), and caps what a script can
 * make the server read at 120 x 18 MB a minute per user.
 */
const SAVE_RATE = {
  charge: (userId: string) => checkRateLimit(`budget-save:${userId}`, { max: 120, windowSecs: 60 }),
  retryAfterSecs: 60,
  message: 'Too many budget saves; wait a minute and try again.',
};

export default withBodyFirst(SAVE_BODY_LIMITS, withAuth(withErrorHandler(withCsrf(withWriteAccess(handler)))), { rate: SAVE_RATE });
