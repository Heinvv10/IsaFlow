/**
 * Shallow health endpoint (liveness probe).
 *
 * - No auth, no CSRF, no withCompany — must be callable by load balancers.
 * - Target <50ms. Does only a single `SELECT 1` round-trip.
 * - Returns 200 when DB is reachable, 503 otherwise.
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';

const PROCESS_START_MS = Date.now();

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ status: 'down', error: 'method_not_allowed' });
  }

  try {
    await sql`SELECT 1`;
    return res.status(200).json({
      status: 'ok',
      db: 'ok',
      uptimeSeconds: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
    });
  } catch {
    return res.status(503).json({
      status: 'down',
      db: 'down',
      uptimeSeconds: Math.floor((Date.now() - PROCESS_START_MS) / 1000),
    });
  }
}
