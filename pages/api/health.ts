import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  try {
    await sql`SELECT 1`;
    return res.status(200).json({ status: 'ok', db: 'ok', timestamp: new Date().toISOString() });
  } catch {
    return res.status(503).json({ status: 'error', db: 'unreachable', timestamp: new Date().toISOString() });
  }
}
