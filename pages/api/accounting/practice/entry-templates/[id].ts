/**
 * Practice Entry Template by ID API
 * GET    /api/accounting/practice/entry-templates/[id] - Get a single template
 * PUT    /api/accounting/practice/entry-templates/[id] - Update a template
 * DELETE /api/accounting/practice/entry-templates/[id] - Delete a template
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  getEntryTemplate,
  updateEntryTemplate,
  deleteEntryTemplate,
} from '@/modules/accounting/services/practice/practiceEntryTemplateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;
  const id = req.query.id as string;

  if (req.method === 'GET') {
    const template = await getEntryTemplate(companyId, id);
    if (!template) return apiResponse.notFound(res, 'Template not found');
    return apiResponse.success(res, template);
  }

  if (req.method === 'PUT') {
    const template = await updateEntryTemplate(companyId, id, req.body as Record<string, unknown>);
    return apiResponse.success(res, template);
  }

  if (req.method === 'DELETE') {
    await deleteEntryTemplate(companyId, id);
    return apiResponse.success(res, { ok: true });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT', 'DELETE']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
