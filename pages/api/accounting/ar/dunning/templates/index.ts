/**
 * GET  /api/accounting/ar/dunning/templates  — list company's templates (seeds on first call)
 * POST /api/accounting/ar/dunning/templates  — create a new template
 *
 * PRD-06 Phase 5. Company-scoped, auth-required.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import {
  listTemplates,
  createTemplate,
} from '@/modules/accounting/services/ar/dunningAdmin';
import type { CreateTemplateInput } from '@/modules/accounting/services/ar/dunningService';

const CreateTemplateSchema = z.object({
  name: z.string().trim().min(1).max(200),
  tone: z.enum(['polite', 'firm', 'final', 'legal']),
  escalation_order: z.number().int().min(1),
  days_overdue_min: z.number().int().min(0),
  days_overdue_max: z.number().int().nullable().optional().default(null),
  subject_template: z.string().trim().min(1).max(500),
  body_template: z.string().trim().min(1).max(50_000),
  send_weekdays_only: z.boolean().optional().default(true),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const templates = await listTemplates(companyId);
    apiResponse.success(res, { templates });
    return;
  }

  if (req.method === 'POST') {
    const parsed = CreateTemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
      return;
    }
    const data = parsed.data;
    try {
      const input: CreateTemplateInput = {
        name: data.name,
        tone: data.tone,
        escalation_order: data.escalation_order,
        days_overdue_min: data.days_overdue_min,
        days_overdue_max: data.days_overdue_max ?? null,
        subject_template: data.subject_template,
        body_template: data.body_template,
        send_weekdays_only: data.send_weekdays_only,
      };
      const tmpl = await createTemplate(companyId, input);
      apiResponse.success(res, tmpl, 'Template created', 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate key|unique constraint/i.test(msg)) {
        res.status(409).json({
          success: false,
          error: { code: 'TEMPLATE_NAME_TAKEN', message: `A template named "${data.name}" already exists` },
        });
        return;
      }
      apiResponse.badRequest(res, msg);
    }
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
