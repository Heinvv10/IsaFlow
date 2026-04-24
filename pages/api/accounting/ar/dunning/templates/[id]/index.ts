/**
 * PUT    /api/accounting/ar/dunning/templates/[id]  — partial update
 * DELETE /api/accounting/ar/dunning/templates/[id]  — soft-deactivate
 *
 * PRD-06 Phase 5 follow-up. Company-scoped, write-only (manager+).
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest, withWriteAccess } from '@/lib/auth';
import {
  updateTemplate,
  deactivateTemplate,
  type UpdateTemplateInput,
} from '@/modules/accounting/services/ar/dunningAdmin';
import type { DunningTone } from '@/modules/accounting/services/ar/dunningService';

const TONES: DunningTone[] = ['polite', 'firm', 'final', 'legal'];

async function handler(req: NextApiRequest, res: NextApiResponse): Promise<void> {
  const { companyId } = req as CompanyAuthedRequest;
  const templateId = typeof req.query.id === 'string' ? req.query.id : '';
  if (!templateId) {
    apiResponse.badRequest(res, 'template id is required in path');
    return;
  }

  if (req.method === 'PUT') {
    const body = (req.body ?? {}) as Record<string, unknown>;
    const input: UpdateTemplateInput = {};

    if (typeof body.name === 'string' && body.name.trim()) input.name = body.name.trim();
    if (typeof body.tone === 'string') {
      if (!(TONES as string[]).includes(body.tone)) {
        apiResponse.badRequest(res, `tone must be one of ${TONES.join(', ')}`);
        return;
      }
      input.tone = body.tone as DunningTone;
    }
    if (body.escalation_order !== undefined) {
      const n = Number(body.escalation_order);
      if (!Number.isInteger(n) || n < 1) {
        apiResponse.badRequest(res, 'escalation_order must be a positive integer');
        return;
      }
      input.escalation_order = n;
    }
    if (body.days_overdue_min !== undefined) {
      const n = Number(body.days_overdue_min);
      if (!Number.isInteger(n) || n < 0) {
        apiResponse.badRequest(res, 'days_overdue_min must be ≥ 0');
        return;
      }
      input.days_overdue_min = n;
    }
    if ('days_overdue_max' in body) {
      if (body.days_overdue_max === null) {
        input.days_overdue_max = null;
      } else {
        const n = Number(body.days_overdue_max);
        if (!Number.isInteger(n)) {
          apiResponse.badRequest(res, 'days_overdue_max must be an integer or null');
          return;
        }
        input.days_overdue_max = n;
      }
    }
    if (typeof body.subject_template === 'string' && body.subject_template.trim()) {
      input.subject_template = body.subject_template;
    }
    if (typeof body.body_template === 'string' && body.body_template.trim()) {
      input.body_template = body.body_template;
    }
    if (typeof body.send_weekdays_only === 'boolean') {
      input.send_weekdays_only = body.send_weekdays_only;
    }
    if (typeof body.active === 'boolean') input.active = body.active;

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

export default withAuth(withErrorHandler(withWriteAccess(handler)));
