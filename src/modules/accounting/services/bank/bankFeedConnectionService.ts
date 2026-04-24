/**
 * Bank Feed Connection Service
 * Connection CRUD — Stitch.money OAuth split to bankFeedOAuthService.ts.
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import { encryptToken } from '@/lib/encryption';
import type { DbRow } from '@/types/db';


export const STITCH_TOKEN_URL = 'https://secure.stitch.money/connect/token';
export const STITCH_GRAPHQL_URL = 'https://api.stitch.money/graphql';

function getConfig() {
  return {
    clientId: process.env.STITCH_CLIENT_ID,
    clientSecret: process.env.STITCH_CLIENT_SECRET,
    redirectUri: process.env.STITCH_REDIRECT_URI,
  };
}

export function isConfigured(): boolean {
  const { clientId, clientSecret, redirectUri } = getConfig();
  return !!(clientId && clientSecret && redirectUri);
}

// Types

export interface BankFeedConnection {
  id: string;
  bankAccountId: string;
  bankAccountName?: string;
  provider: string;
  externalAccountId: string | null;
  bankName: string | null;
  accountNumberMasked: string | null;
  branchCode: string | null;
  accountType: string | null;
  lastSyncAt: string | null;
  syncStatus: string;
  syncError: string | null;
  isActive: boolean;
  createdAt: string;
}

export interface StitchTransaction {
  id: string;
  amount: number;
  runningBalance: number | null;
  description: string;
  reference: string | null;
  date: string;
}

export interface SyncResult {
  fetched: number;
  imported: number;
  skipped: number;
}

// Connection CRUD

export async function listConnections(companyId?: string): Promise<BankFeedConnection[]> {
  const rows = companyId
    ? (await sql`
        SELECT bfc.*, ba.account_name AS bank_account_name
        FROM bank_feed_connections bfc
        LEFT JOIN bank_accounts ba ON ba.id = bfc.bank_account_id
        WHERE ba.company_id = ${companyId}::UUID
        ORDER BY bfc.created_at DESC
      `) as DbRow[]
    : (await sql`
        SELECT bfc.*, ba.account_name AS bank_account_name
        FROM bank_feed_connections bfc
        LEFT JOIN bank_accounts ba ON ba.id = bfc.bank_account_id
        ORDER BY bfc.created_at DESC
      `) as DbRow[];
  return rows.map(mapConnection);
}

export async function getConnection(id: string): Promise<BankFeedConnection | null> {
  const rows = (await sql`
    SELECT bfc.*, ba.account_name AS bank_account_name
    FROM bank_feed_connections bfc
    LEFT JOIN bank_accounts ba ON ba.id = bfc.bank_account_id
    WHERE bfc.id = ${id}::UUID
  `) as DbRow[];
  return rows[0] ? mapConnection(rows[0]) : null;
}

export async function createConnection(input: {
  bankAccountId: string;
  externalAccountId: string;
  bankName?: string;
  accountNumberMasked?: string;
  branchCode?: string;
  accountType?: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  createdBy: string;
}): Promise<BankFeedConnection> {
  const expiresAt = new Date(Date.now() + input.expiresIn * 1000).toISOString();
  const rows = (await sql`
    INSERT INTO bank_feed_connections (
      bank_account_id, provider, external_account_id, bank_name,
      account_number_masked, branch_code, account_type,
      access_token, refresh_token, token_expires_at, sync_status, created_by
    ) VALUES (
      ${input.bankAccountId}::UUID, 'stitch', ${input.externalAccountId},
      ${input.bankName || null}, ${input.accountNumberMasked || null},
      ${input.branchCode || null}, ${input.accountType || null},
      ${encryptToken(input.accessToken)}, ${encryptToken(input.refreshToken)}, ${expiresAt}::TIMESTAMPTZ,
      'pending', ${input.createdBy}::UUID
    ) RETURNING *
  `) as DbRow[];
  log.info('Bank feed connection created', { id: rows[0]!.id, bankName: input.bankName }, 'bank-feeds');
  return mapConnection(rows[0]!);
}

export async function disconnectConnection(id: string, companyId: string): Promise<void> {
  const result = (await sql`
    UPDATE bank_feed_connections SET is_active = false, updated_at = NOW()
    WHERE id = ${id}::UUID AND bank_account_id IN (SELECT id FROM bank_accounts WHERE company_id = ${companyId}::UUID)
    RETURNING id
  `) as DbRow[];
  if (result.length === 0) throw new Error(`Bank feed connection not found: ${id}`);
  log.info('Bank feed disconnected', { id }, 'bank-feeds');
}

// Mapper

export function mapConnection(r: DbRow): BankFeedConnection {
  return {
    id: String(r.id),
    bankAccountId: String(r.bank_account_id),
    bankAccountName: r.bank_account_name ? String(r.bank_account_name) : undefined,
    provider: String(r.provider),
    externalAccountId: r.external_account_id != null ? String(r.external_account_id) : null,
    bankName: r.bank_name != null ? String(r.bank_name) : null,
    accountNumberMasked: r.account_number_masked != null ? String(r.account_number_masked) : null,
    branchCode: r.branch_code != null ? String(r.branch_code) : null,
    accountType: r.account_type != null ? String(r.account_type) : null,
    lastSyncAt: r.last_sync_at != null ? String(r.last_sync_at) : null,
    syncStatus: String(r.sync_status),
    syncError: r.sync_error != null ? String(r.sync_error) : null,
    isActive: Boolean(r.is_active),
    createdAt: String(r.created_at),
  };
}

// OAuth operations re-exported from split file for backward compat
export {
  getAuthorizationUrl,
  exchangeCode,
  refreshAccessToken,
  graphqlQuery,
  fetchStitchAccounts,
  type StitchAccount,
} from './bankFeedOAuthService';
