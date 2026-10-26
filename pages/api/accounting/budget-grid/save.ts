/**
 * Budget grid batch save (Budgets P2, spec §7.2)
 * POST { versionId, expectedUpdatedAt, cells: [{ glAccountId, cc1Id, cc2Id, buId, month: 'YYYY-MM', amount | null }] }
 *   → { updatedAt, saved, deleted }
 * `amount: null` deletes the cell. One batch, one transaction, one audit row. 400 for a bad batch
 * (an account or dimension not the company's, a header or inactive account without amounts in the
 * version, a month outside its year, a grain clash), 404 for another company's version, 409
 * BUDGET_VERSION_LOCKED / BUDGET_VERSION_STALE (with `currentUpdatedAt` and `status`). Every
 * refusal leaves the version, its amounts and its token as they were. The Excel import commits here.
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

export const config = { api: { bodyParser: { sizeLimit: '10mb' } } };

/** The token as P1 answers it (ISO, microseconds, Z) or as Postgres prints timestamptz. */
const TOKEN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])[T ]([01]\d|2[0-3]):[0-5]\d:[0-5]\d(\.\d{1,6})?(Z|[+-]\d{2}(:?\d{2})?)$/;

const SaveSchema = z.object({
  versionId: UUID,
  expectedUpdatedAt: z.string().regex(TOKEN, 'expectedUpdatedAt must be the updatedAt the version was read with'),
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
