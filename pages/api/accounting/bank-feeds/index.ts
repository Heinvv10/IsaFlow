/**
 * Bank Feeds API — list connections + create a new connection
 * GET  /api/accounting/bank-feeds       — list all active connections for the company
 * POST /api/accounting/bank-feeds       — create a new connection
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withCompany, type CompanyApiRequest } from '@/lib/auth';
import { log } from '@/lib/logger';
import {
  listBankFeedConnections,
  createBankFeedConnection,
  type BankFeedConnectionInput,
  type Provider,
} from '@/modules/accounting/services/bank/openBankingService';

const VALID_PROVIDERS: Provider[] = ['manual_csv', 'basiq', 'tink', 'plaid'];

async function handler(req: CompanyApiRequest, res: NextApiResponse) {
  const { companyId } = req;
  const userId = req.user.id;

  if (req.method === 'GET') {
    const connections = await listBankFeedConnections(companyId);
    return apiResponse.success(res, { items: connections, count: connections.length });
  }

  if (req.method === 'POST') {
    const body = req.body as Record<string, unknown>;
    const provider = body.provider as string | undefined;

    if (!provider || !VALID_PROVIDERS.includes(provider as Provider)) {
      return apiResponse.badRequest(
        res,
        `provider is required. Must be one of: ${VALID_PROVIDERS.join(', ')}`,
      );
    }

    const input: BankFeedConnectionInput = {
      provider: provider as Provider,
      accountId: typeof body.accountId === 'string' ? body.accountId : undefined,
      externalAccountId: typeof body.externalAccountId === 'string' ? body.externalAccountId : undefined,
      config: typeof body.config === 'object' && body.config !== null
        ? (body.config as Record<string, unknown>)
        : {},
    };

    log.info('Creating bank feed connection', { provider, companyId }, 'open-banking-api');
    const connection = await createBankFeedConnection(companyId, input, userId);
    return apiResponse.success(res, connection, 'Connection created', 201);
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withCompany(withErrorHandler(handler));
