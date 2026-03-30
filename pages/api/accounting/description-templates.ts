/**
 * Description Templates API
 * WS-6.5: CRUD for transaction description templates
 *
 * GET    — list all templates (optionally filtered by entity_type)
 * POST   — create a new template
 * DELETE — delete template by ?id=<uuid>
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withCompany } from '@/lib/auth/withCompany';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  getTemplates,
  createTemplate,
  deleteTemplate,
} from '@/modules/accounting/services/descriptionTemplateService';
import type { CompanyApiRequest } from '@/lib/auth/withCompany';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const companyReq = req as CompanyApiRequest;
  const companyId = companyReq.companyId;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const entityType = req.query.entity_type as string | undefined;
    const templates = await getTemplates(companyId, entityType);
    return apiResponse.success(res, { items: templates, total: templates.length });
  }

  // ── POST ─────────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { name, template, entityType } = req.body as {
      name?: string;
      template?: string;
      entityType?: string;
    };

    if (!name?.trim()) return apiResponse.badRequest(res, 'name is required');
    if (!template?.trim()) return apiResponse.badRequest(res, 'template is required');
    if (name.trim().length > 100) return apiResponse.badRequest(res, 'name must be 100 characters or less');

    const created = await createTemplate(companyId, name, template, entityType);
    return apiResponse.success(res, created, 'Template created', 201);
  }

  // ── DELETE ────────────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    const id = req.query.id as string | undefined;
    if (!id) return apiResponse.badRequest(res, 'id is required');

    await deleteTemplate(companyId, id);
    return apiResponse.success(res, { deleted: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET', 'POST', 'DELETE']);
}

export default withCompany(withErrorHandler(handler as any) as any);
