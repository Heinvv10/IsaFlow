/**
 * Migration Templates API
 * GET /api/accounting/migration/templates?sourceSystem=xxx&step=xxx
 * Returns a downloadable CSV template for the given source system and wizard step.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getTemplate,
  getTemplateFilename,
  type MigrationSourceSystem,
  type MigrationStep,
} from '@/modules/accounting/services/migrationTemplateService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return apiResponse.methodNotAllowed(res, req.method || 'UNKNOWN', ['GET']);
  }

  const sourceSystem = String(req.query.sourceSystem || '').trim() as MigrationSourceSystem;
  const step = String(req.query.step || '').trim() as MigrationStep;

  if (!sourceSystem) {
    return apiResponse.validationError(res, { sourceSystem: 'sourceSystem query parameter is required' });
  }
  if (!step) {
    return apiResponse.validationError(res, { step: 'step query parameter is required' });
  }

  let template: string;
  try {
    template = getTemplate(sourceSystem, step);
  } catch {
    return apiResponse.notFound(res, 'Template', `${sourceSystem}/${step}`);
  }

  log.info('Migration template downloaded', { sourceSystem, step }, 'migration');

  const filename = getTemplateFilename(sourceSystem, step);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(template);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler as any));
