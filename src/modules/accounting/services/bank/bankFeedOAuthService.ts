/**
 * Bank Feed OAuth Service
 * Stitch.money OAuth token exchange and refresh — split from bankFeedConnectionService.ts.
 */

import { log } from '@/lib/logger';
import crypto from 'crypto';
import { STITCH_TOKEN_URL, STITCH_GRAPHQL_URL } from './bankFeedConnectionService';

function getConfig() {
  return {
    clientId: process.env.STITCH_CLIENT_ID,
    clientSecret: process.env.STITCH_CLIENT_SECRET,
    redirectUri: process.env.STITCH_REDIRECT_URI,
  };
}

const STITCH_AUTH_URL = 'https://secure.stitch.money/connect/authorize';

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
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
