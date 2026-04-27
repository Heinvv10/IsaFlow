/**
 * GET  /api/accounting/ar/dunning/overrides        — list all customer overrides
 * POST /api/accounting/ar/dunning/overrides        — upsert one override
 *   body: { customerId, suppress_dunning?, template_id_override?, note? }
 *
 * PRD-06 Phase 5 follow-up. Company-scoped.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import {
  listOverrides,
  setOverride,
  type UpsertOverrideInput,
} from '@/modules/accounting/services/ar/dunningOverridesService';

const UpsertOverrideSchema = z.object({
  customerId: UUID,
  suppress_dunning: z.boolean().optional(),
  template_id_override: UUID.nullable().optional(),
  note: z.string().trim().max(2000).nullable().optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const overrides = await listOverrides(companyId);
    apiResponse.success(res, { overrides });
    return;
  }

  if (req.method === 'POST') {
    const parsed = UpsertOverrideSchema.safeParse(req.body);
    if (!parsed.success) {
      apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
      return;
    }
    const { customerId, ...rest } = parsed.data;
    const input: UpsertOverrideInput = {};
    if (rest.suppress_dunning !== undefined) input.suppress_dunning = rest.suppress_dunning;
    if (rest.template_id_override !== undefined) input.template_id_override = rest.template_id_override;
    if (rest.note !== undefined) input.note = rest.note ?? null;

    try {
      const override = await setOverride(companyId, customerId, input);
      apiResponse.success(res, { override });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/template .* not found/i.test(msg)) {
        apiResponse.notFound(res, 'Template', String(rest.template_id_override ?? ''));
        return;
      }
      apiResponse.badRequest(res, msg);
    }
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
