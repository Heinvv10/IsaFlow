/**
 * Bank Feed Connections API
 * GET  — list connections
 * POST — create connection, sync, or disconnect
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import {
  listConnections, createConnection, disconnectConnection,
  syncTransactions, getSyncHistory, isConfigured,
} from '@/modules/accounting/services/bankFeedService';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const userId = (req as AuthenticatedNextApiRequest).user.id;

  if (req.method === 'GET') {
    if (req.query.action === 'status') {
      return apiResponse.success(res, { configured: isConfigured() });
    }

    if (req.query.action === 'history' && req.query.connectionId) {
      const history = await getSyncHistory(req.query.connectionId as string);
      return apiResponse.success(res, { items: history });
    }

    const connections = await listConnections();
    return apiResponse.success(res, { items: connections });
  }

  if (req.method === 'POST') {
    const { action } = req.body;

    if (action === 'create') {
      const { bankAccountId, externalAccountId, bankName, accountNumberMasked, branchCode, accountType, accessToken, refreshToken, expiresIn } = req.body;
      if (!bankAccountId || !externalAccountId || !accessToken || !refreshToken) {
        return apiResponse.badRequest(res, 'Missing required fields');
      }
      const connection = await createConnection({
        bankAccountId, externalAccountId, bankName, accountNumberMasked,
        branchCode, accountType, accessToken, refreshToken,
        expiresIn: expiresIn || 3600, createdBy: userId,
      });
      return apiResponse.success(res, connection);
    }

    if (action === 'sync') {
      const { connectionId } = req.body;
      if (!connectionId) return apiResponse.badRequest(res, 'connectionId required');
      const result = await syncTransactions(connectionId);
      return apiResponse.success(res, result);
    }

    if (action === 'disconnect') {
      const { connectionId } = req.body;
      if (!connectionId) return apiResponse.badRequest(res, 'connectionId required');
      await disconnectConnection(connectionId);
      return apiResponse.success(res, { disconnected: true });
    }

    return apiResponse.badRequest(res, 'Invalid action. Use: create, sync, disconnect');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
