/**
 * Public landing page stats — no auth required.
 * Returns real aggregates from the production DB.
 */
import type { NextApiRequest, NextApiResponse } from 'next';
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';

export interface LandingStats {
  transactionAmount: number;   // sum of ABS(amount) from bank_transactions
  businessCount: number;       // non-test companies
  invoiceCount: number;        // customer + supplier invoices
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const [txResult, bizResult, invResult] = await Promise.all([
      sql`SELECT COALESCE(SUM(ABS(amount)), 0) AS total FROM bank_transactions`,
      sql`
        SELECT COUNT(*) AS cnt FROM companies
        WHERE name NOT LIKE 'Test%'
          AND name NOT LIKE '%E2E%'
          AND name NOT LIKE 'STRESS%'
          AND name NOT LIKE 'LARGE%'
          AND name NOT LIKE 'My Test%'
          AND name NOT LIKE 'QA%'
          AND name NOT LIKE 'ISAFlow Demo%'
      `,
      sql`
        SELECT
          (SELECT COUNT(*) FROM customer_invoices) +
          (SELECT COUNT(*) FROM supplier_invoices) AS cnt
      `,
    ]);

    const stats: LandingStats = {
      transactionAmount: Number(txResult[0]?.total ?? 0),
      businessCount:     Number(bizResult[0]?.cnt   ?? 0),
      invoiceCount:      Number(invResult[0]?.cnt    ?? 0),
    };

    // Cache for 1 hour — these numbers change slowly
    res.setHeader('Cache-Control', 'public, s-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json(stats);
  } catch (err) {
    log.error('landing-stats failed', err instanceof Error ? { message: err.message } : { err }, 'LandingStats');
    return res.status(500).json({ error: 'Failed to load stats' });
  }
}
