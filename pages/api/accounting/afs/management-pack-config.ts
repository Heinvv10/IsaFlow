// pages/api/accounting/afs/management-pack-config.ts
import type { NextApiRequest, NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { UUID } from '@/lib/schemas/common';
import {
  PackRecipientSchema,
  PackStyleEnum,
  ComparisonModeEnum,
  CurrencyDisplayEnum,
} from '@/lib/schemas/afs';
import { log } from '@/lib/logger';
import {
  getManagementPackConfig,
  upsertManagementPackConfig,
} from '@/modules/accounting/services/afs/managementPackConfigService';
import type { ManagementPackConfig } from '@/modules/accounting/services/afs/afsTypes';

// Accepts the full ManagementPackConfig the UI round-trips on save.
// Server-controlled fields (id, companyId) are accepted then stripped before
// the service call so a strict schema doesn't reject the UI's full-object PUT.
const PutConfigSchema = z.object({
  id: UUID.optional(),
  companyId: UUID.optional(),
  enabled: z.boolean().optional(),
  deliveryDay: z.number().int().min(1).max(28).optional(),
  generationDay: z.number().int().min(1).max(28).optional(),
  reviewRequired: z.boolean().optional(),
  sectionsEnabled: z.record(z.string().min(1).max(100), z.boolean()).optional(),
  packStyle: PackStyleEnum.optional(),
  comparisonMode: ComparisonModeEnum.optional(),
  currencyDisplay: CurrencyDisplayEnum.optional(),
  recipients: z.array(PackRecipientSchema).max(50).optional(),
}).strict();

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { companyId } = req as CompanyAuthedRequest;

  if (req.method === 'GET') {
    log.info('Fetching management pack config', { companyId }, 'management-pack-config-api');
    const config = await getManagementPackConfig(companyId);
    return apiResponse.success(res, { config });
  }

  if (req.method === 'PUT') {
    // Named per entry: a delivery cannot send to an entry that is not {email, role, receives},
    // so the caller has to be told WHICH one, not just that "recipients" is wrong somewhere.
    const recipients: unknown = req.body?.recipients;
    const malformed = Array.isArray(recipients)
      ? recipients.flatMap((r, i) => {
        const parsed = PackRecipientSchema.safeParse(r);
        return parsed.success ? [] : [{ entry: `recipients[${i}]`, issues: parsed.error.issues.map(issue =>
          `recipients[${i}]${issue.path.map(key => `.${String(key)}`).join('')}: ${issue.message}`) }];
      })
      : [];
    if (malformed.length > 0) {
      return apiResponse.validationError(
        res,
        { recipients: malformed.flatMap(m => m.issues) },
        `Malformed recipients: ${malformed.map(m => m.entry).join(', ')}`,
      );
    }
    const parsed = PutConfigSchema.safeParse(req.body ?? {});
    if (!parsed.success) return apiResponse.zodValidationError(res, parsed.error);
    log.info('Upserting management pack config', { companyId }, 'management-pack-config-api');
    const { id: _id, companyId: _cid, ...updates } = parsed.data;
    const config = await upsertManagementPackConfig(companyId, updates as Partial<ManagementPackConfig>);
    return apiResponse.success(res, { config });
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'UNKNOWN', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(withCsrf(handler as never)));
