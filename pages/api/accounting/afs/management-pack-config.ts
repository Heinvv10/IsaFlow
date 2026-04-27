// pages/api/accounting/afs/management-pack-config.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  getManagementPackConfig,
  upsertManagementPackConfig,
} from '@/modules/accounting/services/afs/managementPackConfigService';
import type { ManagementPackConfig, PackRecipient } from '@/modules/accounting/services/afs/afsTypes';

const PACK_STYLES = ['executive', 'detailed', 'board'] as const;
const COMPARISON_MODES = ['prior_month', 'prior_year', 'budget', 'all_three'] as const;
const CURRENCY_DISPLAYS = ['full', 'thousands', 'millions'] as const;
const RECEIVES_OPTIONS = ['draft', 'final', 'both'] as const;

function validatePutBody(body: unknown): { valid: boolean; error?: string } {
  if (typeof body !== 'object' || body === null) {
    return { valid: false, error: 'Request body must be an object' };
  }

  const b = body as Record<string, unknown>;

  if (b.deliveryDay !== undefined) {
    const d = Number(b.deliveryDay);
    if (!Number.isInteger(d) || d < 1 || d > 28) {
      return { valid: false, error: 'deliveryDay must be an integer between 1 and 28' };
    }
  }

  if (b.generationDay !== undefined) {
    const d = Number(b.generationDay);
    if (!Number.isInteger(d) || d < 1 || d > 28) {
      return { valid: false, error: 'generationDay must be an integer between 1 and 28' };
    }
  }

  if (b.packStyle !== undefined && !PACK_STYLES.includes(b.packStyle as ManagementPackConfig['packStyle'])) {
    return { valid: false, error: `packStyle must be one of: ${PACK_STYLES.join(', ')}` };
  }

  if (b.comparisonMode !== undefined && !COMPARISON_MODES.includes(b.comparisonMode as ManagementPackConfig['comparisonMode'])) {
    return { valid: false, error: `comparisonMode must be one of: ${COMPARISON_MODES.join(', ')}` };
  }

  if (b.currencyDisplay !== undefined && !CURRENCY_DISPLAYS.includes(b.currencyDisplay as ManagementPackConfig['currencyDisplay'])) {
    return { valid: false, error: `currencyDisplay must be one of: ${CURRENCY_DISPLAYS.join(', ')}` };
  }

  if (b.recipients !== undefined) {
    if (!Array.isArray(b.recipients)) {
      return { valid: false, error: 'recipients must be an array' };
    }
    for (const r of b.recipients as unknown[]) {
      if (typeof r !== 'object' || r === null) {
        return { valid: false, error: 'Each recipient must be an object' };
      }
      const rec = r as Partial<PackRecipient>;
      if (!rec.email || typeof rec.email !== 'string') {
        return { valid: false, error: 'Each recipient must have a valid email string' };
      }
      if (!rec.role || typeof rec.role !== 'string') {
        return { valid: false, error: 'Each recipient must have a role string' };
      }
      if (!rec.receives || !RECEIVES_OPTIONS.includes(rec.receives)) {
        return { valid: false, error: `Each recipient.receives must be one of: ${RECEIVES_OPTIONS.join(', ')}` };
      }
    }
  }

  return { valid: true };
}

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    log.info('Fetching management pack config', { companyId }, 'management-pack-config-api');
    const config = await getManagementPackConfig(companyId);
    return apiResponse.success(res, { config });
  }

  if (req.method === 'PUT') {
    const validation = validatePutBody(req.body);
    if (!validation.valid) {
      return apiResponse.badRequest(res, validation.error ?? 'Invalid request body');
    }
    log.info('Upserting management pack config', { companyId }, 'management-pack-config-api');
    const config = await upsertManagementPackConfig(companyId, req.body as Partial<ManagementPackConfig>);
    return apiResponse.success(res, { config });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
