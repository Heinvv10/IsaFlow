/**
 * Bank Feed Sync Service — transaction fetching, sync orchestration, and history.
 *
 * Handles: token refresh, pagination via Stitch GraphQL, deduplication, sync logging.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { encryptToken, decryptToken } from '@/lib/encryption';
import type { SyncResult, StitchTransaction } from './bankFeedConnectionService';
import { refreshAccessToken, graphqlQuery } from './bankFeedConnectionService';

type Row = Record<string, unknown>;

// ── Stitch transaction fetching ───────────────────────────────────────────────

/**
 * Fetch transactions for a specific account from Stitch.
 * Supports cursor-based pagination for incremental sync.
 */
export async function fetchStitchTransactions(
  accessToken: string,
  accountId: string,
  afterCursor?: string,
  limit = 100,
): Promise<{
  transactions: StitchTransaction[];
  endCursor: string | null;
  hasNextPage: boolean;
}> {
  const query = `
    query GetTransactions($accountId: ID!, $first: Int!, $after: String) {
      node(id: $accountId) {
        ... on BankAccount {
          transactions(first: $first, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { id amount runningBalance description reference date }
          }
        }
      }
    }
  `;

  const data = await graphqlQuery(accessToken, query, {
    accountId,
    first: limit,
    after: afterCursor || null,
  });

  const txConnection = data?.node?.transactions;
  const nodes = txConnection?.nodes ?? [];
  const pageInfo = txConnection?.pageInfo ?? {};

  return {
    transactions: nodes.map((t: Record<string, unknown>) => ({
      id: t.id as string,
      amount: Number(t.amount),
      runningBalance: t.runningBalance != null ? Number(t.runningBalance) : null,
      description: (t.description as string) || '',
      reference: (t.reference as string) || null,
      date: t.date as string,
    })),
    endCursor: (pageInfo.endCursor as string) || null,
    hasNextPage: !!pageInfo.hasNextPage,
  };
}

// ── Sync orchestration ────────────────────────────────────────────────────────

/**
 * Sync transactions for a connection.
 * Handles token refresh, pagination, and deduplication.
 */
export async function syncTransactions(connectionId: string): Promise<SyncResult> {
  const conn = (await sql`
    SELECT * FROM bank_feed_connections WHERE id = ${connectionId}::UUID AND is_active = true
  `) as Row[];
  if (!conn[0]) throw new Error('Connection not found or inactive');

  const connection = conn[0];
  let accessToken = decryptToken(connection.access_token as string);
  const refreshToken = decryptToken(connection.refresh_token as string);

  // Refresh token if expired
  if (new Date(String(connection.token_expires_at)) <= new Date()) {
    log.info('Refreshing expired token', { connectionId }, 'bank-feeds');
    const refreshed = await refreshAccessToken(refreshToken);
    accessToken = refreshed.accessToken;
    const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
    await sql`
      UPDATE bank_feed_connections SET
        access_token = ${encryptToken(refreshed.accessToken)},
        refresh_token = ${encryptToken(refreshed.refreshToken)},
        token_expires_at = ${newExpiry}::TIMESTAMPTZ,
        updated_at = NOW()
      WHERE id = ${connectionId}::UUID
    `;
  }

  // Create sync log entry
  const logRows = (await sql`
    INSERT INTO bank_feed_sync_log (connection_id, sync_type)
    VALUES (${connectionId}::UUID, ${connection.last_sync_cursor ? 'incremental' : 'full'})
    RETURNING id
  `) as Row[];
  const syncLogId = String(logRows[0]!.id);

  await sql`
    UPDATE bank_feed_connections SET sync_status = 'syncing', updated_at = NOW()
    WHERE id = ${connectionId}::UUID
  `;

  let totalFetched = 0;
  let totalImported = 0;
  let totalSkipped = 0;
  let cursor: string | undefined = connection.last_sync_cursor ? String(connection.last_sync_cursor) : undefined;

  try {
    let hasMore = true;
    while (hasMore) {
      const result = await fetchStitchTransactions(
        accessToken,
        String(connection.external_account_id),
        cursor,
        100,
      );
      totalFetched += result.transactions.length;

      for (const tx of result.transactions) {
        const existing = (await sql`
          SELECT id FROM bank_transactions
          WHERE bank_account_id = ${connection.bank_account_id}::UUID
            AND bank_reference = ${tx.id}
          LIMIT 1
        `) as Row[];

        if (existing.length > 0) {
          totalSkipped++;
          continue;
        }

        await sql`
          INSERT INTO bank_transactions (
            bank_account_id, transaction_date, amount, description,
            reference, bank_reference, status, import_batch_id
          ) VALUES (
            ${connection.bank_account_id}::UUID, ${tx.date}::DATE, ${tx.amount},
            ${tx.description}, ${tx.reference || null}, ${tx.id},
            'imported', NULL
          )
        `;
        totalImported++;
      }

      cursor = result.endCursor || undefined;
      hasMore = result.hasNextPage;
    }

    await sql`
      UPDATE bank_feed_connections SET
        last_sync_at = NOW(),
        last_sync_cursor = ${cursor || null},
        sync_status = 'synced',
        sync_error = NULL,
        updated_at = NOW()
      WHERE id = ${connectionId}::UUID
    `;

    await sql`
      UPDATE bank_feed_sync_log SET
        transactions_fetched = ${totalFetched},
        transactions_imported = ${totalImported},
        transactions_skipped = ${totalSkipped},
        completed_at = NOW(),
        status = 'completed'
      WHERE id = ${syncLogId}::UUID
    `;

    log.info('Bank feed sync completed', {
      connectionId, fetched: totalFetched, imported: totalImported, skipped: totalSkipped,
    }, 'bank-feeds');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Sync failed';
    await sql`
      UPDATE bank_feed_connections SET sync_status = 'error', sync_error = ${errorMessage}, updated_at = NOW()
      WHERE id = ${connectionId}::UUID
    `;
    await sql`
      UPDATE bank_feed_sync_log SET status = 'failed', error = ${errorMessage}, completed_at = NOW()
      WHERE id = ${syncLogId}::UUID
    `;
    log.error('Bank feed sync failed', { connectionId, error: errorMessage }, 'bank-feeds');
    throw error;
  }

  return { fetched: totalFetched, imported: totalImported, skipped: totalSkipped };
}

// ── Sync history ──────────────────────────────────────────────────────────────

/**
 * Get sync history for a connection.
 */
export async function getSyncHistory(
  connectionId: string,
  limit = 20,
): Promise<Array<{
  id: string;
  syncType: string;
  fetched: number;
  imported: number;
  skipped: number;
  startedAt: string;
  completedAt: string | null;
  status: string;
  error: string | null;
}>> {
  const rows = (await sql`
    SELECT * FROM bank_feed_sync_log
    WHERE connection_id = ${connectionId}::UUID
    ORDER BY started_at DESC
    LIMIT ${limit}
  `) as Row[];

  return rows.map((r: Row) => ({
    id: String(r.id),
    syncType: String(r.sync_type),
    fetched: Number(r.transactions_fetched),
    imported: Number(r.transactions_imported),
    skipped: Number(r.transactions_skipped),
    startedAt: String(r.started_at),
    completedAt: r.completed_at != null ? String(r.completed_at) : null,
    status: String(r.status),
    error: r.error != null ? String(r.error) : null,
  }));
}
