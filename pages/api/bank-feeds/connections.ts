/**
 * Bank Feed Connections API
 * GET  — list connections
 * POST — sync or disconnect a connection (create is handled by callback.ts OAuth flow)
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import {
  listConnections, disconnectConnection,
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

    // NOTE: The 'create' action (which previously accepted raw accessToken and
    // refreshToken from the client body) has been removed. Accepting OAuth tokens
    // from client-supplied body is a security anti-pattern — tokens must only
    // arrive via the server-side OAuth callback flow in:
    //   pages/api/bank-feeds/callback.ts
    // That handler validates the OAuth state, exchanges the code for tokens, and
    // calls createConnection() directly. Do not re-add a client-facing create path.

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

    return apiResponse.badRequest(res, 'Invalid action. Use: sync, disconnect');
  }

  return apiResponse.methodNotAllowed(res, req.method!, ['GET', 'POST']);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export default withAuth(withErrorHandler(handler));
