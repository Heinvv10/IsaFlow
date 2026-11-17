/**
 * The bulk-accept batch the CURRENT user started on this bank account at or after `since`, not yet undone: how the modal finds
 * the batch whose confirm answer was lost, so Undo stays possible. Scoped to the company, the user and the account - another
 * person's batch is never offered - and to runs that posted something.
 */
import { sql } from '@/lib/neon';

export interface RecentBatch { id: string; postedCount: number; totalAmount: number }

export async function findOwnRecentBatch(companyId: string, userId: string, bankAccountId: string, since: Date): Promise<RecentBatch | null> {
  const [row] = (await sql`
    SELECT r.id::TEXT AS id, r.posted_count, r.total_amount
    FROM bank_auto_post_runs r
    WHERE r.company_id = ${companyId}::UUID AND r.source = 'manual' AND r.created_by = ${userId}::UUID
      AND r.undone_at IS NULL AND r.posted_count > 0 AND r.created_at >= ${since.toISOString()}::TIMESTAMPTZ
      AND EXISTS (SELECT 1 FROM bank_transactions bt
                  WHERE bt.auto_post_run_id = r.id AND bt.company_id = ${companyId}::UUID AND bt.bank_account_id = ${bankAccountId}::UUID)
    ORDER BY r.created_at DESC
    LIMIT 1`) as Array<{ id: string; posted_count: number | string; total_amount: number | string }>;
  return row ? { id: row.id, postedCount: Number(row.posted_count), totalAmount: Number(row.total_amount) } : null;
}
