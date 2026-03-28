/**
 * Bank Feed Service — Stitch.money Integration
 * OAuth flow, transaction sync, connection management.
 *
 * Environment variables required:
 *   STITCH_CLIENT_ID     — Stitch application client ID
 *   STITCH_CLIENT_SECRET — Stitch application secret
 *   STITCH_REDIRECT_URI  — OAuth callback URL (e.g. https://app.isaflow.co.za/api/bank-feeds/callback)
 */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import crypto from 'crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;

// ── Config ───────────────────────────────────────────────────────────────────

const STITCH_AUTH_URL = 'https://secure.stitch.money/connect/authorize';
const STITCH_TOKEN_URL = 'https://secure.stitch.money/connect/token';
const STITCH_GRAPHQL_URL = 'https://api.stitch.money/graphql';

function getConfig() {
  const clientId = process.env.STITCH_CLIENT_ID;
  const clientSecret = process.env.STITCH_CLIENT_SECRET;
  const redirectUri = process.env.STITCH_REDIRECT_URI;
  return { clientId, clientSecret, redirectUri };
}

function isConfigured(): boolean {
  const { clientId, clientSecret, redirectUri } = getConfig();
  return !!(clientId && clientSecret && redirectUri);
}

// ── Types ────────────────────────────────────────────────────────────────────

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

export interface StitchAccount {
  id: string;
  name: string;
  bankId: string;
  accountType: string;
  accountNumber: string;
  branchCode: string;
  currency: string;
  currentBalance: number | null;
  availableBalance: number | null;
}

export interface SyncResult {
  fetched: number;
  imported: number;
  skipped: number;
}

// ── PKCE Helpers ─────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// ── OAuth Flow ───────────────────────────────────────────────────────────────

/**
 * Generate the Stitch authorization URL for linking a bank account.
 * Returns { url, state, codeVerifier } — store state + codeVerifier in session.
 */
export function getAuthorizationUrl(): {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
} {
  const { clientId, redirectUri } = getConfig();
  if (!clientId || !redirectUri) {
    throw new Error('Stitch integration not configured. Set STITCH_CLIENT_ID and STITCH_REDIRECT_URI.');
  }

  const state = crypto.randomBytes(16).toString('hex');
  const nonce = crypto.randomBytes(16).toString('hex');
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid accounts transactions balances offline_access',
    redirect_uri: redirectUri,
    state,
    nonce,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });

  return {
    url: `${STITCH_AUTH_URL}?${params.toString()}`,
    state,
    nonce,
    codeVerifier,
  };
}

/**
 * Exchange authorization code for access + refresh tokens.
 */
export async function exchangeCode(
  code: string,
  codeVerifier: string
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { clientId, clientSecret, redirectUri } = getConfig();
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error('Stitch integration not configured');
  }

  const res = await fetch(STITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    log.error('Stitch token exchange failed', { status: res.status, error }, 'bank-feeds');
    throw new Error(`Token exchange failed: ${res.status}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Refresh an expired access token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) {
    throw new Error('Stitch integration not configured');
  }

  const res = await fetch(STITCH_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    log.error('Stitch token refresh failed', { status: res.status, error }, 'bank-feeds');
    throw new Error(`Token refresh failed: ${res.status}`);
  }

  const data = await res.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in,
  };
}

// ── GraphQL Queries ──────────────────────────────────────────────────────────

async function graphqlQuery(accessToken: string, query: string, variables?: Record<string, unknown>) {
  const res = await fetch(STITCH_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`GraphQL request failed: ${res.status} — ${error}`);
  }

  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

/**
 * Fetch linked bank accounts from Stitch.
 */
export async function fetchStitchAccounts(accessToken: string): Promise<StitchAccount[]> {
  const query = `
    query {
      user {
        bankAccounts {
          id
          name
          bankId
          accountType
          accountNumber
          branchCode
          currency
          currentBalance
          availableBalance
        }
      }
    }
  `;

  const data = await graphqlQuery(accessToken, query);
  const accounts = data?.user?.bankAccounts ?? [];

  return accounts.map((a: Record<string, unknown>) => ({
    id: a.id as string,
    name: a.name as string,
    bankId: a.bankId as string,
    accountType: a.accountType as string,
    accountNumber: a.accountNumber as string,
    branchCode: a.branchCode as string,
    currency: (a.currency as string) || 'ZAR',
    currentBalance: a.currentBalance != null ? Number(a.currentBalance) : null,
    availableBalance: a.availableBalance != null ? Number(a.availableBalance) : null,
  }));
}

/**
 * Fetch transactions for a specific account from Stitch.
 * Supports cursor-based pagination for incremental sync.
 */
export async function fetchStitchTransactions(
  accessToken: string,
  accountId: string,
  afterCursor?: string,
  limit = 100
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
            pageInfo {
              hasNextPage
              endCursor
            }
            nodes {
              id
              amount
              runningBalance
              description
              reference
              date
            }
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

// ── Connection Management ────────────────────────────────────────────────────

export async function listConnections(): Promise<BankFeedConnection[]> {
  const rows = (await sql`
    SELECT bfc.*, ba.account_name AS bank_account_name
    FROM bank_feed_connections bfc
    LEFT JOIN bank_accounts ba ON ba.id = bfc.bank_account_id
    ORDER BY bfc.created_at DESC
  `) as Row[];
  return rows.map(mapConnection);
}

export async function getConnection(id: string): Promise<BankFeedConnection | null> {
  const rows = (await sql`
    SELECT bfc.*, ba.account_name AS bank_account_name
    FROM bank_feed_connections bfc
    LEFT JOIN bank_accounts ba ON ba.id = bfc.bank_account_id
    WHERE bfc.id = ${id}::UUID
  `) as Row[];
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
      ${input.accessToken}, ${input.refreshToken}, ${expiresAt}::TIMESTAMPTZ,
      'pending', ${input.createdBy}::UUID
    ) RETURNING *
  `) as Row[];

  log.info('Bank feed connection created', { id: rows[0].id, bankName: input.bankName }, 'bank-feeds');
  return mapConnection(rows[0]);
}

export async function disconnectConnection(id: string): Promise<void> {
  await sql`
    UPDATE bank_feed_connections SET is_active = false, updated_at = NOW()
    WHERE id = ${id}::UUID
  `;
  log.info('Bank feed disconnected', { id }, 'bank-feeds');
}

// ── Transaction Sync ─────────────────────────────────────────────────────────

/**
 * Sync transactions for a connection.
 * Handles token refresh, pagination, and deduplication.
 */
export async function syncTransactions(connectionId: string): Promise<SyncResult> {
  const conn = (await sql`SELECT * FROM bank_feed_connections WHERE id = ${connectionId}::UUID AND is_active = true`) as Row[];
  if (!conn[0]) throw new Error('Connection not found or inactive');

  const connection = conn[0];
  let accessToken = connection.access_token;
  const refreshToken = connection.refresh_token;
  const externalAccountId = connection.external_account_id;

  // Refresh token if expired
  const tokenExpiry = new Date(connection.token_expires_at);
  if (tokenExpiry <= new Date()) {
    log.info('Refreshing expired token', { connectionId }, 'bank-feeds');
    const refreshed = await refreshAccessToken(refreshToken);
    accessToken = refreshed.accessToken;
    const newExpiry = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
    await sql`
      UPDATE bank_feed_connections SET
        access_token = ${refreshed.accessToken},
        refresh_token = ${refreshed.refreshToken},
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
  const syncLogId = logRows[0].id;

  // Update status
  await sql`UPDATE bank_feed_connections SET sync_status = 'syncing', updated_at = NOW() WHERE id = ${connectionId}::UUID`;

  let totalFetched = 0;
  let totalImported = 0;
  let totalSkipped = 0;
  let cursor = connection.last_sync_cursor || undefined;

  try {
    let hasMore = true;
    while (hasMore) {
      const result = await fetchStitchTransactions(accessToken, externalAccountId, cursor, 100);
      totalFetched += result.transactions.length;

      for (const tx of result.transactions) {
        // Check for duplicates by external reference
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

        // Import transaction
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

    // Update connection
    await sql`
      UPDATE bank_feed_connections SET
        last_sync_at = NOW(),
        last_sync_cursor = ${cursor || null},
        sync_status = 'synced',
        sync_error = NULL,
        updated_at = NOW()
      WHERE id = ${connectionId}::UUID
    `;

    // Complete sync log
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

/**
 * Get sync history for a connection.
 */
export async function getSyncHistory(connectionId: string, limit = 20): Promise<Array<{
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
    id: r.id,
    syncType: r.sync_type,
    fetched: r.transactions_fetched,
    imported: r.transactions_imported,
    skipped: r.transactions_skipped,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    status: r.status,
    error: r.error,
  }));
}

/** Check if Stitch integration is configured */
export { isConfigured };

// ── Mapper ───────────────────────────────────────────────────────────────────

function mapConnection(r: Row): BankFeedConnection {
  return {
    id: r.id,
    bankAccountId: r.bank_account_id,
    bankAccountName: r.bank_account_name || undefined,
    provider: r.provider,
    externalAccountId: r.external_account_id,
    bankName: r.bank_name,
    accountNumberMasked: r.account_number_masked,
    branchCode: r.branch_code,
    accountType: r.account_type,
    lastSyncAt: r.last_sync_at,
    syncStatus: r.sync_status,
    syncError: r.sync_error,
    isActive: r.is_active,
    createdAt: r.created_at,
  };
}
