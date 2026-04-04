/**
 * GET /api/auth/preferences  — returns all preferences as { key: value } map
 * PUT /api/auth/preferences  — upserts { preferences: { key: value, ... } }
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { withAuth, type AuthenticatedNextApiRequest } from '@/lib/auth';
import { withErrorHandler } from '@/lib/api-error-handler';
import { apiResponse } from '@/lib/apiResponse';
import { sql, transaction } from '@/lib/neon';
import { log } from '@/lib/logger';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

async function handler(req: NextApiRequest, res: NextApiResponse) {
  const authReq = req as AuthenticatedNextApiRequest;
  const userId = authReq.user.id;

  // ── GET ──────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const rows = (await sql`
      SELECT key, value FROM user_preferences WHERE user_id = ${userId}
    `) as Row[];

    const prefs: Record<string, string> = {};
    for (const row of rows) {
      prefs[row.key as string] = row.value as string;
    }

    return apiResponse.success(res, prefs);
  }

  // ── PUT ──────────────────────────────────────────────────────────────────
  if (req.method === 'PUT') {
    const { preferences } = req.body as { preferences?: Record<string, string> };

    if (!preferences || typeof preferences !== 'object') {
      return apiResponse.badRequest(res, 'preferences object is required');
    }

    const entries = Object.entries(preferences);
    if (entries.length === 0) {
      return apiResponse.success(res, {}, 'No preferences to update');
    }

    // Batch upsert all preferences in a single transaction
    await transaction((txSql) =>
      entries.map(([key, value]) =>
        txSql`
          INSERT INTO user_preferences (user_id, key, value, updated_at)
          VALUES (${userId}, ${key}, ${String(value)}, NOW())
          ON CONFLICT (user_id, key)
          DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()
        `
      )
    );

    log.info('Preferences updated', { userId, keys: Object.keys(preferences) }, 'auth/preferences');

    return apiResponse.success(res, preferences, 'Preferences saved');
  }

  return apiResponse.methodNotAllowed(res, req.method ?? 'unknown', ['GET', 'PUT']);
}

export default withAuth(withErrorHandler(handler) as any);
