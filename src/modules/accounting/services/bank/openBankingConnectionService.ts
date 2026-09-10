/** Open Banking — connection CRUD and sync log queries */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import type { DbRow } from '@/types/db';
import {
  mapConnection,
  mapSyncLog,
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
      bfc.external_account_id,
      bfc.status,
      bfc.last_sync_at,
      bfc.last_sync_status,
      bfc.last_sync_error,
      COALESCE(bfc.config, '{}')  AS config,
      bfc.created_at,
      bfc.updated_at
    FROM bank_feed_connections bfc
    LEFT JOIN gl_accounts ba ON ba.id = bfc.bank_account_id
      AND ba.company_id = bfc.company_id
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
  // basiq | tink | plaid are not implemented — syncing one imports nothing,
  // so refuse the connection at creation time rather than at first sync.
  const validProviders = ['manual_csv', 'extension'] as const;
  if (!validProviders.includes(input.provider as typeof validProviders[number])) {
    throw new Error(`Invalid provider "${input.provider}". Must be one of: ${validProviders.join(', ')}`);
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
  const rows = (await sql`
    INSERT INTO bank_feed_connections (
      company_id, bank_account_id, provider,
      external_account_id, status, config, created_by, is_active
    ) VALUES (
      ${companyId}::UUID,
      ${input.accountId ?? null}::UUID,
      ${input.provider},
      ${input.externalAccountId ?? null},
      'active',
      ${configJson}::JSONB,
      ${userId}::UUID,
      true
    )
    RETURNING *
  `) as DbRow[];

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
  await sql`
    UPDATE bank_feed_connections
    SET is_active = false, updated_at = NOW()
    WHERE id = ${connectionId}::UUID
      AND company_id = ${companyId}::UUID
  `;
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
