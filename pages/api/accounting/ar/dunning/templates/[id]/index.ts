/**
 * PUT    /api/accounting/ar/dunning/templates/[id]  — partial update
 * DELETE /api/accounting/ar/dunning/templates/[id]  — soft-deactivate
 *
 * PRD-06 Phase 5 follow-up. Company-scoped, write-only (manager+).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import {
  updateTemplate,
  deactivateTemplate,
  type UpdateTemplateInput,
} from '@/modules/accounting/services/ar/dunningAdmin';

const UpdateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  tone: z.enum(['polite', 'firm', 'final', 'legal']).optional(),
  escalation_order: z.number().int().min(1).optional(),
  days_overdue_min: z.number().int().min(0).optional(),
  days_overdue_max: z.number().int().nullable().optional(),
  subject_template: z.string().trim().min(1).max(500).optional(),
  body_template: z.string().trim().min(1).max(50_000).optional(),
  send_weekdays_only: z.boolean().optional(),
  active: z.boolean().optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const idParse = UUID.safeParse(req.query.id);
  if (!idParse.success) {
    apiResponse.badRequest(res, 'template id must be a valid UUID');
    return;
  }
  const templateId = idParse.data;

  if (req.method === 'PUT') {
    const parsed = UpdateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
      return;
    }
    const input: UpdateTemplateInput = parsed.data;

    try {
      const updated = await updateTemplate(companyId, templateId, input);
      if (!updated) {
        apiResponse.notFound(res, 'Template', templateId);
        return;
      }
      apiResponse.success(res, updated);
    } catch (err) {
      apiResponse.badRequestFromError(res, err, 'Request failed');
    }
    return;
  }

  if (req.method === 'DELETE') {
    const ok = await deactivateTemplate(companyId, templateId);
    if (!ok) {
      apiResponse.notFound(res, 'Template', templateId);
      return;
    }
    apiResponse.success(res, { deactivated: true });
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
