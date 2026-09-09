/** Open Banking — transaction fetching, deduplication, and sync orchestration */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { type BankFeedSyncResult, type Provider } from './openBankingTypes';
import type { DbRow } from '@/types/db';


// ── Sync orchestration ────────────────────────────────────────────────────────

async function markSyncComplete(
  logId: string,
  connectionId: string,
  found: number,
  imported: number,
  duplicate: number,
) {
  await sql`
    UPDATE bank_feed_sync_logs
    SET status = 'success', completed_at = NOW(),
        transactions_found = ${found},
        transactions_imported = ${imported},
        transactions_duplicate = ${duplicate}
    WHERE id = ${logId}::UUID
  `;
  await sql`
    UPDATE bank_feed_connections
    SET last_sync_at = NOW(), last_sync_status = 'success',
        last_sync_error = NULL, updated_at = NOW()
    WHERE id = ${connectionId}::UUID
  `;
}

async function markSyncFailed(logId: string, connectionId: string, errMsg: string) {
  await sql`
    UPDATE bank_feed_sync_logs
    SET status = 'failed', completed_at = NOW(), error_message = ${errMsg}
    WHERE id = ${logId}::UUID
  `;
  await sql`
    UPDATE bank_feed_connections
    SET last_sync_at = NOW(), last_sync_status = 'failed',
        last_sync_error = ${errMsg}, updated_at = NOW()
    WHERE id = ${connectionId}::UUID
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
    LEFT JOIN bank_accounts ba ON ba.id = bfc.bank_account_id
    WHERE bfc.id = ${connectionId}::UUID
      AND bfc.company_id = ${companyId}::UUID
      AND bfc.is_active = true
    LIMIT 1
  `) as DbRow[];

  if (connRows.length === 0) {
    throw new Error('Connection not found or does not belong to this company');
  }

  const conn = connRows[0]!;
  const provider = String(conn.provider) as Provider;

  const logRows = (await sql`
    INSERT INTO bank_feed_sync_logs (connection_id, company_id, status)
    VALUES (${connectionId}::UUID, ${companyId}::UUID, 'running')
    RETURNING id
  `) as DbRow[];
  const logId = String(logRows[0]!.id);

  log.info('Bank feed sync started', { connectionId, provider, companyId, userId }, 'open-banking');

  // manual_csv: return instructions without inserting transactions
  if (provider === 'manual_csv') {
    await markSyncComplete(logId, connectionId, 0, 0, 0);
    return {
      connectionId, provider, logId, found: 0, imported: 0, duplicate: 0,
      instructions: 'Manual CSV import: use the Bank Transactions import page to upload your bank statement file.',
    };
  }

  // extension: must be synced from the browser extension itself; this
  // server-only endpoint cannot reach the user's authenticated bank tab.
  if (provider === 'extension') {
    await markSyncComplete(logId, connectionId, 0, 0, 0);
    return {
      connectionId, provider, logId, found: 0, imported: 0, duplicate: 0,
      instructions: 'Browser-extension feeds sync directly from your bank tab. Click Sync on the Bank Feeds page (or open the extension popup) — that triggers the real scrape via /extension-ingest.',
    };
  }

  // basiq | tink | plaid have no integration behind them. They used to fall
  // through to a random sample-transaction generator whose invented rows were
  // INSERTed into the tenant's bank_transactions as 'imported' and reported as
  // a successful sync. Refuse instead — an unimplemented feed imports nothing.
  const errMsg = `Bank feed provider "${provider}" is not implemented — no transactions were imported. Use the browser extension or a manual CSV import instead.`;
  await markSyncFailed(logId, connectionId, errMsg);
  log.error('Bank feed sync refused — provider not implemented', { connectionId, provider, companyId }, 'open-banking');
  throw new Error(errMsg);
}
