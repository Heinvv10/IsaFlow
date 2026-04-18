/**
 * Bank Feed Connections API
 * GET  — list connections
 * POST — sync or disconnect a connection (create is handled by callback.ts OAuth flow)
 */

import type { NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type CompanyAuthedRequest } from '@/lib/auth';
import {
  listConnections, disconnectConnection,
  syncTransactions, getSyncHistory, isConfigured,
} from '@/modules/accounting/services/bank/bankFeedService';

async function handler(req: CompanyAuthedRequest, res: NextApiResponse) {
  const { companyId } = req;

  if (req.method === 'GET') {
    if (req.query.action === 'status') {
      return apiResponse.success(res, { configured: isConfigured() });
    }

    if (req.query.action === 'history' && req.query.connectionId) {
      const history = await getSyncHistory(req.query.connectionId as string, companyId);
      return apiResponse.success(res, { items: history });
    }

    const connections = await listConnections(companyId);
    return apiResponse.success(res, { items: connections });
  }

  if (req.method === 'POST') {
    const { action } = req.body;

    if (action === 'sync') {
      const { connectionId } = req.body;
      if (!connectionId) return apiResponse.badRequest(res, 'connectionId required');
      const result = await syncTransactions(connectionId, companyId);
      return apiResponse.success(res, result);
    }

    if (action === 'disconnect') {
      const { connectionId } = req.body;
      if (!connectionId) return apiResponse.badRequest(res, 'connectionId required');
      await disconnectConnection(connectionId, companyId);
      return apiResponse.success(res, { disconnected: true });
    }

    return apiResponse.badRequest(res, 'Invalid action. Use: sync, disconnect');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

export default withAuth(withErrorHandler(handler));
