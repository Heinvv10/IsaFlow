/**
 * GET  /api/auth/2fa-trusted-devices  — List trusted devices
 * DELETE /api/auth/2fa-trusted-devices?id=UUID — Remove a trusted device
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth } from '@/lib/auth/middleware';
import type { AuthenticatedNextApiRequest } from '@/lib/auth/middleware';
import { apiResponse } from '@/lib/apiResponse';
import { getTrustedDevices, removeTrustedDevice } from '@/modules/auth/services/twoFactorService';
import { log } from '@/lib/logger';

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const { user } = req as AuthenticatedNextApiRequest;

  if (req.method === 'GET') {
    try {
      const devices = await getTrustedDevices(user.id);
      return apiResponse.success(res, { devices });
    } catch (err) {
      log.error('2fa-trusted-devices GET error', err instanceof Error ? { message: err.message } : { err }, 'api/auth/2fa-trusted-devices');
      return apiResponse.internalError(res, err);
    }
  }

  if (req.method === 'DELETE') {
    const { id } = req.query;
    if (!id || typeof id !== 'string') {
      return apiResponse.badRequest(res, 'Device ID is required');
    }

    try {
      await removeTrustedDevice(user.id, id);
      log.info('Trusted device removed via API', { userId: user.id, deviceId: id }, 'api/auth/2fa-trusted-devices');
      return apiResponse.success(res, null, 'Device removed');
    } catch (err) {
      log.error('2fa-trusted-devices DELETE error', err instanceof Error ? { message: err.message } : { err }, 'api/auth/2fa-trusted-devices');
      return apiResponse.internalError(res, err);
    }
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET', 'DELETE']);
}

export default withAuth(handler);
