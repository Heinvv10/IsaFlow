/**
 * GET  /api/accounting/ar/dunning/templates  — list company's templates (seeds on first call)
 * POST /api/accounting/ar/dunning/templates  — create a new template
 *
 * PRD-06 Phase 5. Company-scoped, auth-required.
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import {
  listTemplates,
  createTemplate,
} from '@/modules/accounting/services/ar/dunningAdmin';
import type {
  DunningTone,
  CreateTemplateInput,
} from '@/modules/accounting/services/ar/dunningService';

const TONES: DunningTone[] = ['polite', 'firm', 'final', 'legal'];

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    const templates = await listTemplates(companyId);
    apiResponse.success(res, { templates });
    return;
  }

  if (req.method === 'POST') {
    const body = req.body ?? {};
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    const tone = typeof body.tone === 'string' ? body.tone : '';
    const escalation_order = Number(body.escalation_order);
    const days_overdue_min = Number(body.days_overdue_min);
    const days_overdue_max_raw = body.days_overdue_max;
    const days_overdue_max = days_overdue_max_raw == null ? null : Number(days_overdue_max_raw);
    const subject_template =
      typeof body.subject_template === 'string' ? body.subject_template : '';
    const body_template = typeof body.body_template === 'string' ? body.body_template : '';
    const send_weekdays_only = body.send_weekdays_only !== false;

    if (!name) {
      apiResponse.badRequest(res, 'name is required');
      return;
    }
    if (!(TONES as string[]).includes(tone)) {
      apiResponse.badRequest(res, `tone must be one of ${TONES.join(', ')}`);
      return;
    }
    if (!Number.isInteger(escalation_order) || escalation_order < 1) {
      apiResponse.badRequest(res, 'escalation_order must be a positive integer');
      return;
    }
    if (!Number.isInteger(days_overdue_min) || days_overdue_min < 0) {
      apiResponse.badRequest(res, 'days_overdue_min must be a non-negative integer');
      return;
    }
    if (days_overdue_max !== null && !Number.isInteger(days_overdue_max)) {
      apiResponse.badRequest(res, 'days_overdue_max must be an integer or null');
      return;
    }
    if (!subject_template.trim()) {
      apiResponse.badRequest(res, 'subject_template is required');
      return;
    }
    if (!body_template.trim()) {
      apiResponse.badRequest(res, 'body_template is required');
      return;
    }

    try {
      const input: CreateTemplateInput = {
        name,
        tone: tone as DunningTone,
        escalation_order,
        days_overdue_min,
        days_overdue_max,
        subject_template,
        body_template,
        send_weekdays_only,
      };
      const tmpl = await createTemplate(companyId, input);
      apiResponse.success(res, tmpl, 'Template created', 201);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/duplicate key|unique constraint/i.test(msg)) {
        res.status(409).json({
          success: false,
          error: { code: 'TEMPLATE_NAME_TAKEN', message: `A template named "${name}" already exists` },
        });
        return;
      }
      apiResponse.badRequest(res, msg);
    }
    return;
  }

  apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withWriteAccess(handler)));
