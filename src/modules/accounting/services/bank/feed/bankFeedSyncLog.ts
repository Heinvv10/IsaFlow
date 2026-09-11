// src/modules/accounting/services/bank/feed/bankFeedSyncLog.ts
/** Sync-log reads that must stay clear of the balance-computing `is_active` guard. */
import { sql } from '@/lib/neon';
import type { DbRow } from '@/lib/neon';

/** Rows this connection inserted in the last 24 hours (the extension anti-abuse cap). */
export async function importedInLastDay(companyId: string, connectionId: string): Promise<number> {
  const rows = (await sql`
    SELECT COALESCE(SUM(transactions_imported), 0)::INT AS used
    FROM bank_feed_sync_logs
    WHERE connection_id = ${connectionId}::UUID AND company_id = ${companyId}::UUID
      AND started_at > NOW() - INTERVAL '24 hours'`) as DbRow[];
  return Number(rows[0]?.used ?? 0);
}
