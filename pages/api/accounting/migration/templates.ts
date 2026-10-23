/**
 * Migration Templates API
 * GET /api/accounting/migration/templates?sourceSystem=xxx&step=xxx
 * Returns a downloadable CSV template for the given source system and wizard step.
 * A missing sourceSystem gets the generic template rather than an error: five
 * wizard pages never sent one, and a refusal there left the operator with no
 * template at all.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, withWriteAccess} from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getTemplate,
  getTemplateFilename,
  type MigrationSourceSystem,
  type MigrationStep,
} from '@/modules/accounting/services/core/migrationTemplateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const sourceSystem = (String(req.query.sourceSystem || '').trim() || 'other') as MigrationSourceSystem;
  const step = String(req.query.step || '').trim() as MigrationStep;

  if (!step) {
    return apiResponse.validationError(res, { step: 'step query parameter is required' });
  }

  let template: string;
  try {
    template = getTemplate(sourceSystem, step);
  } catch (err) {
    log.warn('Migration template not found', { sourceSystem, step, error: err }, 'migration');
    return apiResponse.notFound(res, 'Template', `${sourceSystem}/${step}`);
  }

  log.info('Migration template downloaded', { sourceSystem, step }, 'migration');

  const filename = getTemplateFilename(sourceSystem, step);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(template);
}

 
export default withAuth(withErrorHandler(withWriteAccess(handler)));
