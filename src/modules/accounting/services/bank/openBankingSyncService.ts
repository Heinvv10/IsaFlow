/** Open Banking — transaction fetching, deduplication, and sync orchestration */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { type BankFeedSyncResult } from './openBankingTypes';
import type { DbRow } from '@/types/db';


/**
 * Thrown when a connection names a provider that has no integration behind it.
 * The route answers 4xx on this so `withAuth` COMMITs the failed sync log — a
 * 500 would roll the audit trail back with the rest of the transaction.
 */
export class BankFeedProviderNotImplementedError extends Error {
  constructor(public readonly provider: string) {
    super(`Bank feed provider "${provider}" is not implemented — no transactions were imported. Use the browser extension or a manual CSV import instead.`);
    this.name = 'BankFeedProviderNotImplementedError';
  }
}

// ── Sync orchestration ────────────────────────────────────────────────────────

async function markSyncFailed(companyId: string, logId: string, connectionId: string, errMsg: string) {
  await sql`
    UPDATE bank_feed_sync_logs
    SET status = 'failed', completed_at = NOW(), error_message = ${errMsg}
    WHERE id = ${logId}::UUID AND company_id = ${companyId}::UUID
  `;
  await sql`
    UPDATE bank_feed_connections
    SET last_sync_at = NOW(), last_sync_status = 'failed',
        last_sync_error = ${errMsg}, updated_at = NOW()
    WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID
  `;
}

export async function syncBankFeed(
  companyId: string,
  connectionId: string,
  userId: string,
): Promise<BankFeedSyncResult> {
  // IDOR guard: verify connection belongs to company
  const connRows = (await sql`
    SELECT bfc.*, ba.account_name
    FROM bank_feed_connections bfc
    LEFT JOIN gl_accounts ba ON ba.id = bfc.bank_account_id
      AND ba.company_id = bfc.company_id
    WHERE bfc.id = ${connectionId}::UUID
      AND bfc.company_id = ${companyId}::UUID
      AND bfc.is_active = true
    LIMIT 1
  `) as DbRow[];

  if (connRows.length === 0) {
    throw new Error('Connection not found or does not belong to this company');
  }

  const conn = connRows[0]!;
  const provider = String(conn.provider);
  log.info('Bank feed sync requested', { connectionId, provider, companyId, userId }, 'open-banking');

  // Instruction-only providers sync nothing, so they write no sync log and
  // leave last_sync_* alone: a "success" here would claim a sync that never ran.
  // manual_csv: return instructions without inserting transactions
  if (provider === 'manual_csv') {
    return {
      connectionId, provider, logId: null, found: 0, imported: 0, duplicate: 0,
      instructions: 'Manual imports are user-operated: upload your statement (CSV, PDF, OFX or QIF) on the Bank Transactions import page.',
    };
  }

  // extension: must be synced from the browser extension itself; this
  // server-only endpoint cannot reach the user's authenticated bank tab.
  if (provider === 'extension') {
    return {
      connectionId, provider, logId: null, found: 0, imported: 0, duplicate: 0,
      instructions: 'ABSA browser import is user-operated: open the IsaFlow extension in your signed-in ABSA tab and click Import. IsaFlow cannot fetch from your bank in the background.',
    };
  }

  // Any other provider (legacy rows only — basiq/tink/plaid connections
  // created before this release) has no integration behind it. It used to
  // fall through to a random sample-transaction generator whose invented rows
  // were INSERTed into the tenant's bank_transactions as 'imported' and
  // reported as a successful sync. Refuse instead — an unimplemented feed
  // imports nothing.
  const logRows = (await sql`
    INSERT INTO bank_feed_sync_logs (connection_id, company_id, status)
    VALUES (${connectionId}::UUID, ${companyId}::UUID, 'running')
    RETURNING id
  `) as DbRow[];
  const logId = String(logRows[0]!.id);
  const refusal = new BankFeedProviderNotImplementedError(provider);
  await markSyncFailed(companyId, logId, connectionId, refusal.message);
  log.error('Bank feed sync refused — provider not implemented', { connectionId, provider, companyId }, 'open-banking');
  throw refusal;
}
