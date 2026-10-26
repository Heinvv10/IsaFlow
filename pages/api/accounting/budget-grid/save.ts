/**
 * Budget grid batch save (Budgets P2, spec §7.2)
 * POST { versionId, expectedUpdatedAt, cells: [{ glAccountId, cc1Id, cc2Id, buId, month: 'YYYY-MM', amount | null }] }
 *   → { updatedAt, saved, deleted }
 * `amount: null` deletes the cell. One batch, one transaction, one audit row. 400 for a bad batch
 * (an account or dimension not the company's, a header or inactive account without amounts in the
 * version, a month outside its year, a grain clash), 404 for another company's version, 409
 * BUDGET_VERSION_LOCKED / BUDGET_VERSION_STALE (with `currentUpdatedAt` and `status`). Every
 * refusal leaves the version, its amounts and its token as they were. The Excel import commits here.
 * The body is read after authentication, at most 24 MB (413 above it); at most MAX_SAVE_CELLS cells.
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse, ErrorCode } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { BudgetVersionStaleError, MAX_SAVE_CELLS, saveCells } from '@/modules/accounting/services/budgets/gridSave';
import { isVersionToken } from '@/modules/accounting/services/budgets/gridErrors';
import { JsonBodyError, readJsonBody } from '@/lib/readJsonBody';

// The handler reads the body itself, after the auth wrappers: Next's parser would buffer and parse
// it before withAuth, and withErrorHandler would log it (round-2 SEC2-M2, M3).
export const config = { api: { bodyParser: false } };

/** MAX_SAVE_CELLS (100 000) cells of compact JSON are at most ~17 MB (172 bytes for the widest cell). */
const MAX_BODY_BYTES = 24 * 1048576;

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
  })).max(MAX_SAVE_CELLS),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  let body: unknown;
  try {
    body = await readJsonBody(req, MAX_BODY_BYTES);
  } catch (err) {
    if (!(err instanceof JsonBodyError)) throw err;
    return apiResponse.error(res, err.status === 413 ? ErrorCode.PAYLOAD_TOO_LARGE : ErrorCode.BAD_REQUEST, err.message);
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

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
