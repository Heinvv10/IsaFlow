/**
 * Budget grid create wizard (Budgets P2, spec 8)
 * POST { fiscalYear, name, kind, makePrimary, roundingUnit: 1 | 100 | 1000, includeNoActivity?,
 *        source: { type: 'py_actuals', upliftPct, grain: 'company' | 'cc1' | 'cc2' | 'bu', unassigned?: 'company' | 'drop' }
 *              | { type: 'version', versionId, upliftPct } | { type: 'blank' } }
 *   → { versionId, updatedAt, cells, skippedAccounts }
 * Creates a DRAFT version and its amounts in one transaction. `unassigned` (dimension grains only,
 * default 'company') decides an account whose PY has rows with no member: 'company' budgets it at
 * company level entirely, 'drop' keeps only its tagged rows. `makePrimary` is owner/admin only
 * (403, nothing created). 400 for bad input, 404 for another company's source version (or one
 * whose own year label the registry has no year for), 409 for a taken name or a second original.
 */
import { z } from 'zod';
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, type AuthenticatedNextApiRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import { respondBudgetVersionError } from '@/lib/budgetVersionResponse';
import { FiscalYearLabelUnknownError } from '@/modules/accounting/services/gl/fiscalYearRegistry';
import { seedVersion } from '@/modules/accounting/services/budgets/seedVersion';

const Uplift = z.number().finite().min(-100).max(1000);

const SeedSchema = z.object({
  fiscalYear: z.number().int().min(1).max(9999),
  name: z.string(),
  kind: z.string(),
  makePrimary: z.boolean().default(false),
  roundingUnit: z.union([z.literal(1), z.literal(100), z.literal(1000)]),
  includeNoActivity: z.boolean().default(false),
  source: z.discriminatedUnion('type', [
    z.object({
      type: z.literal('py_actuals'), upliftPct: Uplift, grain: z.enum(['company', 'cc1', 'cc2', 'bu']),
      unassigned: z.enum(['company', 'drop']).default('company'),
    }),
    z.object({ type: z.literal('version'), versionId: UUID.transform((id) => id.toLowerCase()), upliftPct: Uplift }),
    z.object({ type: z.literal('blank') }),
  ]),
});

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') return apiResponse.methodNotAllowed(res, req.method!, ['POST']);
  const { companyId, companyRole } = req as CompanyAuthedRequest;
  const userId = (req as AuthenticatedNextApiRequest).user.id;
  const parsed = SeedSchema.safeParse(req.body);
  if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
  try {
    return apiResponse.success(res, await seedVersion(companyId, { userId, role: companyRole }, parsed.data));
  } catch (err) {
    if (respondBudgetVersionError(res, err)) return;
    if (err instanceof FiscalYearLabelUnknownError) return apiResponse.notFound(res, 'Financial year', String(err.fiscalYear));
    throw err;
  }
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
