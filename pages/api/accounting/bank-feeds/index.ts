/**
 * Bank Feeds API — list connections + create a new connection
 * GET  /api/accounting/bank-feeds       — list all active connections for the company
 * POST /api/accounting/bank-feeds       — create a new connection
 */

import type { NextApiResponse } from 'next';
import { z } from 'zod';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import { withCsrf } from '@/lib/auth/withCsrf';
import { log } from '@/lib/logger';
import {
  listBankFeedConnections,
  createBankFeedConnection,
  type BankFeedConnectionInput,
} from '@/modules/accounting/services/bank/openBankingService';

const CreateConnectionSchema = z.object({
  provider: z.enum(['manual_csv', 'extension']),
  accountId: z.string().max(200).optional(),
  externalAccountId: z.string().max(200).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
}).strict();

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;

  if (req.method === 'GET') {
    const connections = await listBankFeedConnections(companyId);
    return apiResponse.success(res, { items: connections, count: connections.length });
  }

  if (req.method === 'POST') {
    const parsed = CreateConnectionSchema.safeParse(req.body);
    if (!parsed.success) {
      return apiResponse.validationError(res, parsed.error.flatten().fieldErrors);
    }
    const input: BankFeedConnectionInput = {
      provider: parsed.data.provider,
      accountId: parsed.data.accountId,
      externalAccountId: parsed.data.externalAccountId,
      config: parsed.data.config ?? {},
    };

    log.info('Creating bank feed connection', { provider: input.provider, companyId }, 'open-banking-api');
    const connection = await createBankFeedConnection(companyId, input, userId);
    return apiResponse.success(res, connection, 'Connection created', 201);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(withCsrf(handler)));
