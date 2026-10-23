/**
 * Public landing page stats — no auth required.
 * Returns real aggregates from the production DB (src/lib/landing/landingStats.ts).
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { getLandingStats } from '@/lib/landing/landingStats';

export type { LandingStats } from '@/lib/landing/landingStats';

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // getLandingStats logs the DB error itself and never throws.
  const stats = await getLandingStats();
  if (!stats) {
    return res.status(500).json({ error: 'Failed to load stats' });
  }

  // Cache for 1 hour — these numbers change slowly
  res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
  return res.status(200).json(stats);
}
