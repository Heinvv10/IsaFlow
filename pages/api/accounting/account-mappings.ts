/**
 * Account External Mappings API — WS-7.3
 * GET  /api/accounting/account-mappings?system=caseware     — list mappings
 * POST /api/accounting/account-mappings                     — save single mapping
 * POST /api/accounting/account-mappings (action=auto-suggest) — bulk auto-suggest
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  getAccountMappings,
  saveAccountMapping,
  autoSuggestAllMappings,
} from '@/modules/accounting/services/casewareExportService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyApiRequest;

  if (req.method === 'GET') {
    const targetSystem = (req.query.system as string) || 'caseware';
    const validSystems = ['caseware', 'xbrl', 'custom'];
    if (!validSystems.includes(targetSystem)) {
      return apiResponse.badRequest(res, `system must be one of: ${validSystems.join(', ')}`);
    }

    try {
      const mappings = await getAccountMappings(companyId, targetSystem);
      return apiResponse.success(res, { items: mappings, total: mappings.length });
    } catch (err) {
      log.error('Failed to get account mappings', { error: err, companyId }, 'account-mappings-api');
      return apiResponse.badRequest(res, 'Failed to retrieve account mappings');
    }
  }

  if (req.method === 'POST') {
    const { action, glAccountId, targetSystem, externalCode, externalLabel } = req.body as {
      action?: string;
      glAccountId?: string;
      targetSystem?: string;
      externalCode?: string;
      externalLabel?: string;
    };

    if (action === 'auto-suggest') {
      try {
        const suggestions = await autoSuggestAllMappings(companyId);
        const system = targetSystem ?? 'caseware';

        await Promise.all(
          suggestions.map(s =>
            saveAccountMapping(companyId, s.glAccountId, system, s.code, s.label),
          ),
        );

        log.info('Auto-suggested mappings applied', { companyId, count: suggestions.length }, 'account-mappings-api');
        return apiResponse.success(res, { applied: suggestions.length });
      } catch (err) {
        log.error('Auto-suggest failed', { error: err, companyId }, 'account-mappings-api');
        return apiResponse.badRequest(res, 'Auto-suggest failed');
      }
    }

    if (!glAccountId || !targetSystem || !externalCode) {
      return apiResponse.badRequest(res, 'glAccountId, targetSystem and externalCode are required');
    }

    const validSystems = ['caseware', 'xbrl', 'custom'];
    if (!validSystems.includes(targetSystem)) {
      return apiResponse.badRequest(res, `targetSystem must be one of: ${validSystems.join(', ')}`);
    }

    try {
      await saveAccountMapping(companyId, glAccountId, targetSystem, externalCode, externalLabel);
      log.info('Account mapping saved', { companyId, glAccountId, targetSystem }, 'account-mappings-api');
      return apiResponse.success(res, { saved: true });
    } catch (err) {
      log.error('Failed to save account mapping', { error: err }, 'account-mappings-api');
      return apiResponse.badRequest(res, 'Failed to save account mapping');
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withCompany(withErrorHandler(handler));
