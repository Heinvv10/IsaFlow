/**
 * Practice Entry Templates API
 * GET  /api/accounting/practice/entry-templates  - List templates for current user
 * POST /api/accounting/practice/entry-templates  - Create a template
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { withWriteAccess } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import {
  listEntryTemplates,
  createEntryTemplate,
} from '@/modules/accounting/services/practice/practiceEntryTemplateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authed = req as CompanyAuthedRequest;
  const { companyId } = authed;
  const userId = authed.user.id;

  if (req.method === 'GET') {
    const templates = await listEntryTemplates(companyId, userId);
    return apiResponse.success(res, { templates });
  }

  if (req.method === 'POST') {
    const {
      name,
      practiceClientId,
      jobCategoryId,
      workItemId,
      defaultHours,
      taskDescription,
      notes,
      billable,
    } = req.body as Record<string, unknown>;

    if (!name || typeof name !== 'string' || !name.trim()) {
      return apiResponse.badRequest(res, 'template name is required');
    }

    const template = await createEntryTemplate(companyId, userId, {
      name: String(name),
      practiceClientId: typeof practiceClientId === 'string' ? practiceClientId : null,
      jobCategoryId: typeof jobCategoryId === 'string' ? jobCategoryId : null,
      workItemId: typeof workItemId === 'string' ? workItemId : null,
      defaultHours: defaultHours !== undefined && defaultHours !== null ? Number(defaultHours) : null,
      taskDescription: typeof taskDescription === 'string' ? taskDescription : null,
      notes: typeof notes === 'string' ? notes : null,
      billable: typeof billable === 'boolean' ? billable : true,
    });
    return apiResponse.created(res, template);
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(withWriteAccess(handler))));
