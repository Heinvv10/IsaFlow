/**
 * Public landing page stats — real aggregates across the whole database.
 * Server-only (imports the DB client). Shared by GET /api/landing-stats and
 * the landing page's getStaticProps; returns only three numbers, no tenant data.
 */
import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { LandingStats } from './landingStatsFormat';

export type { LandingStats } from './landingStatsFormat';

/** The live aggregates, or null when the DB cannot be read (never throws). */
export async function getLandingStats(): Promise<LandingStats | null> {
  try {
    const [txResult, bizResult, invResult] = await Promise.all([
      sql`SELECT COALESCE(SUM(ABS(amount)), 0) AS total FROM bank_transactions WHERE feed_state = 'posted'`,
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

    return {
      transactionAmount: Number(txResult[0]?.total ?? 0),
      businessCount:     Number(bizResult[0]?.cnt   ?? 0),
      invoiceCount:      Number(invResult[0]?.cnt    ?? 0),
    };
  } catch (err) {
    log.error('landing-stats failed', err instanceof Error ? { message: err.message } : { err }, 'LandingStats');
    return null;
  }
}
