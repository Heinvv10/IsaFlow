/**
 * GET  /api/accounting/ar/dunning/overrides        — list all customer overrides
 * POST /api/accounting/ar/dunning/overrides        — upsert one override
 *   body: { customerId, suppress_dunning?, template_id_override?, note? }
 *
 * PRD-06 Phase 5 follow-up. Company-scoped.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import {
  listOverrides,
  setOverride,
  type UpsertOverrideInput,
} from '@/modules/accounting/services/ar/dunningOverridesService';

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const overrides = await listOverrides(companyId);
    apiResponse.success(res, { overrides });
    return;
  }

  if (req.method === 'POST') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const customerId = typeof body.customerId === 'string' ? body.customerId : '';
    if (!customerId) {
      apiResponse.badRequest(res, 'customerId is required');
      return;
    }

    const input: UpsertOverrideInput = {};
    if (typeof body.suppress_dunning === 'boolean') input.suppress_dunning = body.suppress_dunning;
    if ('template_id_override' in body) {
      input.template_id_override =
        typeof body.template_id_override === 'string' && body.template_id_override.length > 0
          ? body.template_id_override
          : null;
    }
    if ('note' in body) {
      input.note = typeof body.note === 'string' && body.note.trim().length > 0
        ? body.note.trim()
        : null;
    }

    try {
      const override = await setOverride(companyId, customerId, input);
      apiResponse.success(res, { override });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/template .* not found/i.test(msg)) {
        apiResponse.notFound(res, 'Template', String(body.template_id_override ?? ''));
        return;
      }
      apiResponse.badRequest(res, msg);
    }
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
