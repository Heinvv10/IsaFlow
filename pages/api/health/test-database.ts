/**
 * Says only whether this server runs on a dev or CI database, for the e2e guard (tests/e2e/helpers/devTarget.ts).
 *
 * - No auth: the guard asks before any login. The answer is one boolean (false in production).
 */

import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { isTestDatabaseServer } from '@/lib/observability/testDatabase';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ testDatabase: false });
  }

  try {
    const rows = await sql`SELECT current_database() AS name`;
    return res.status(200).json({ testDatabase: isTestDatabaseServer(rows[0]?.name, process.env) });
  } catch (error) {
    log.warn('test-database health check failed', { error: error instanceof Error ? error.message : String(error) });
    return res.status(503).json({ testDatabase: false });
  }
}
