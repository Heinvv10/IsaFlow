/**
 * Open Banking — connection CRUD and sync log queries.
 *
 * Create and disconnect run on the migration_admin pool (S-07d, migration
 * 935): a connection's is_active is the revocation switch for the extension's
 * 90-day pairing JWT (withExtensionToken), so no app role may INSERT a
 * connection or UPDATE more than its sync stamps (forged claims revived a
 * revoked pairing). `companyId` and `userId` are the verified request's.
 */

import { sql } from '@/lib/neon';
import { migrationAdminTx } from '@/lib/auth/migrationAdminPool';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import {
  mapConnection,
  mapSyncLog,
  isSupportedProvider,
  type BankFeedConnection,
  type BankFeedConnectionInput,
  type BankFeedSyncLog,
} from './openBankingTypes';
import { BANK_SUBTYPES } from '../gl/accountSubtypes';


// ── Connection CRUD ───────────────────────────────────────────────────────────

export async function listBankFeedConnections(companyId: string): Promise<BankFeedConnection[]> {
  const rows = (await sql`
    SELECT
      bfc.id,
      bfc.company_id,
      bfc.provider,
      bfc.bank_account_id  AS account_id,
      ba.account_name,
      bfc.account_number_masked,
      bfc.external_account_id,
      bfc.status,
      bfc.last_sync_at,
      bfc.last_success_at,
      bfc.last_sync_status,
      bfc.last_sync_error,
      COALESCE(bfc.config, '{}')  AS config,
      bfc.created_at,
      bfc.updated_at,
      ls.ls_found,
      ls.ls_imported,
      ls.ls_duplicate,
      ls.ls_updated,
      ls.ls_pending,
      ls.ls_removed,
      ls.ls_conflict,
      ls.ls_completed_at
    FROM bank_feed_connections bfc
    LEFT JOIN gl_accounts ba ON ba.id = bfc.bank_account_id
      AND ba.company_id = bfc.company_id
    LEFT JOIN LATERAL (
      SELECT
        l.transactions_found    AS ls_found,
        l.transactions_imported AS ls_imported,
        l.transactions_duplicate AS ls_duplicate,
        l.transactions_updated  AS ls_updated,
        l.transactions_pending  AS ls_pending,
        l.transactions_removed  AS ls_removed,
        l.transactions_conflict AS ls_conflict,
        l.completed_at          AS ls_completed_at
      FROM bank_feed_sync_logs l
      WHERE l.connection_id = bfc.id AND l.company_id = bfc.company_id
      ORDER BY l.started_at DESC
      LIMIT 1
    ) ls ON TRUE
    WHERE bfc.company_id = ${companyId}::UUID
      AND bfc.is_active = true
    ORDER BY bfc.created_at DESC
  `) as DbRow[];
  return rows.map(mapConnection);
}

export async function createBankFeedConnection(
  companyId: string,
  input: BankFeedConnectionInput,
  userId: string,
): Promise<BankFeedConnection> {
  // Any provider other than manual_csv or extension has no integration behind
  // it — syncing one imports nothing, so refuse the connection at creation
  // time rather than at first sync.
  if (!isSupportedProvider(input.provider)) {
    throw new Error(`Invalid provider "${input.provider}". Must be one of: manual_csv, extension`);
  }

  // Defence in depth behind the route's strict schema: config holds the
  // extension's bank id and nothing else — never credentials (A-I1).
  const extraKeys = Object.keys(input.config ?? {}).filter((k) => k !== 'bankId');
  if (extraKeys.length > 0) {
    throw new Error('Unsupported connection config: only bankId may be set');
  }

  // bank_account_id is NOT NULL for extension connections in practice: an
  // extension feed with no target GL account has nowhere to post imported
  // rows. Refuse here rather than surface the raw NOT NULL constraint error.
  if (input.provider === 'extension' && !input.accountId) {
    throw new Error('A bank account is required for this connection');
  }

  // IDOR guard — bankAccountId across this codebase means gl_accounts.id
  // (account_subtype='bank'). bank_transactions FKs to gl_accounts; as of
  // migration 483, bank_feed_connections does too.
  if (input.accountId) {
    const check = (await sql`
      SELECT id FROM gl_accounts
       WHERE id = ${input.accountId}::UUID
         AND company_id = ${companyId}::UUID
         AND account_subtype = ANY(${BANK_SUBTYPES as string[]})
       LIMIT 1
    `) as DbRow[];
    if (check.length === 0) {
      throw new Error('Bank account not found or does not belong to this company');
    }
  }

  const configJson = JSON.stringify(input.config ?? {});
  const rows = await migrationAdminTx('create bank feed connection', async (client) => (await client.query(
    `INSERT INTO bank_feed_connections (
       company_id, bank_account_id, provider,
       external_account_id, status, config, created_by, is_active
     ) VALUES ($1::UUID, $2::UUID, $3, $4, 'active', $5::JSONB, $6::UUID, true)
     RETURNING *`,
    [companyId, input.accountId ?? null, input.provider, input.externalAccountId ?? null, configJson, userId],
  )).rows as DbRow[]);

  const created = rows[0]!;
  log.info('Open banking connection created', {
    id: String(created.id), provider: input.provider, companyId,
  }, 'open-banking');

  return mapConnection({ ...created, account_name: null, account_id: input.accountId ?? null });
}

export async function deleteBankFeedConnection(
  companyId: string,
  connectionId: string,
): Promise<void> {
  await migrationAdminTx('disconnect bank feed', (client) => client.query(
    `UPDATE bank_feed_connections
        SET is_active = false, status = 'disconnected', updated_at = NOW()
      WHERE id = $1::UUID
        AND company_id = $2::UUID`,
    [connectionId, companyId],
  ));
  log.info('Open banking connection deleted', { connectionId, companyId }, 'open-banking');
}

// ── Sync logs ─────────────────────────────────────────────────────────────────

export async function getBankFeedSyncLogs(
  companyId: string,
  connectionId: string,
  limit = 10,
): Promise<BankFeedSyncLog[]> {
  // IDOR guard: verify connection belongs to company
  const connCheck = (await sql`
    SELECT id FROM bank_feed_connections
    WHERE id = ${connectionId}::UUID AND company_id = ${companyId}::UUID
    LIMIT 1
  `) as DbRow[];
  if (connCheck.length === 0) return [];

  const rows = (await sql`
    SELECT *
    FROM bank_feed_sync_logs
    WHERE connection_id = ${connectionId}::UUID
      AND company_id = ${companyId}::UUID
    ORDER BY started_at DESC
    LIMIT ${limit}
  `) as DbRow[];

  return rows.map(mapSyncLog);
}
