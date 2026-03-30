/**
 * Custom Report Templates API
 * GET    — list templates (own + shared)
 * POST   — save or update template
 * DELETE — delete template (?id=X)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getTemplates,
  getTemplateById,
  saveTemplate,
  deleteTemplate,
  type TemplateInput,
} from '@/modules/accounting/services/customReportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId, user } = req as CompanyApiRequest;
  const userId = user.id;

  if (req.method === 'GET') {
    if (req.query.id) {
      const template = await getTemplateById(companyId, String(req.query.id));
      if (!template) return apiResponse.notFound(res, 'Template');
      return apiResponse.success(res, template);
    }
    const templates = await getTemplates(companyId, userId);
    return apiResponse.success(res, { items: templates });
  }

  if (req.method === 'POST') {
    const body = req.body as TemplateInput;
    if (!body.name?.trim()) return apiResponse.badRequest(res, 'name is required');
    if (!body.dataSource) return apiResponse.badRequest(res, 'dataSource is required');
    if (!Array.isArray(body.columns) || body.columns.length === 0) {
      return apiResponse.badRequest(res, 'At least one column is required');
    }
    const template = await saveTemplate(companyId, userId, body);
    log.info('Template saved via API', { id: template.id, companyId }, 'CustomReportsAPI');
    return apiResponse.success(res, template);
  }

  if (req.method === 'DELETE') {
    const id = req.query.id ? String(req.query.id) : req.body?.id;
    if (!id) return apiResponse.badRequest(res, 'id is required');
    try {
      await deleteTemplate(companyId, userId, id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Delete failed';
      if (msg.includes('not found')) return apiResponse.notFound(res, 'Template');
      if (msg.includes('do not own')) return apiResponse.forbidden(res, msg);
      throw err;
    }
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST', 'DELETE']);
}

export default withCompany(withErrorHandler(handler as never));
