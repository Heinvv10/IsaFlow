/** Bank Feed Connection Service — Stitch.money OAuth, token management, and connection CRUD. */

import { sql } from '@/lib/neon';
import { log } from '@/lib/logger';
import crypto from 'crypto';
import { encryptToken, decryptToken } from '@/lib/encryption';

type Row = Record<string, unknown>;

const STITCH_AUTH_URL = 'https://secure.stitch.money/connect/authorize';
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

// PKCE helpers

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

// OAuth Flow

/** Generate Stitch authorization URL. Store state + codeVerifier in session. */
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

  return { url: `${STITCH_AUTH_URL}?${params.toString()}`, state, nonce, codeVerifier };
}

/** Exchange authorization code for access + refresh tokens. */
export async function exchangeCode(
  code: string,
  codeVerifier: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
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
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresIn: data.expires_in };
}

/** Refresh an expired access token. */
export async function refreshAccessToken(refreshToken: string): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}> {
  const { clientId, clientSecret } = getConfig();
  if (!clientId || !clientSecret) throw new Error('Stitch integration not configured');

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

// GraphQL

export async function graphqlQuery(
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
) {
  const res = await fetch(STITCH_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) {
    const error = await res.text();
    throw new Error(`GraphQL request failed: ${res.status} — ${error}`);
  }
  const json = await res.json();
  if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

/** Fetch linked bank accounts from Stitch. */
export async function fetchStitchAccounts(accessToken: string): Promise<StitchAccount[]> {
  const query = `query { user { bankAccounts { id name bankId accountType accountNumber branchCode currency currentBalance availableBalance } } }`;
  const data = await graphqlQuery(accessToken, query);
  return (data?.user?.bankAccounts ?? []).map((a: Record<string, unknown>) => ({
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

// Connection CRUD

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
      ${encryptToken(input.accessToken)}, ${encryptToken(input.refreshToken)}, ${expiresAt}::TIMESTAMPTZ,
      'pending', ${input.createdBy}::UUID
    ) RETURNING *
  `) as Row[];
  log.info('Bank feed connection created', { id: rows[0]!.id, bankName: input.bankName }, 'bank-feeds');
  return mapConnection(rows[0]!);
}

export async function disconnectConnection(id: string): Promise<void> {
  await sql`UPDATE bank_feed_connections SET is_active = false, updated_at = NOW() WHERE id = ${id}::UUID`;
  log.info('Bank feed disconnected', { id }, 'bank-feeds');
}

// Mapper

export function mapConnection(r: Row): BankFeedConnection {
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

