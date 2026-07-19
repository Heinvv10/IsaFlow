/**
 * Integration test: OAuth auth-code exchange WITHOUT offline_access must mint a
 * token (regression for migration 508).
 *
 * issueTokens() only generates a refresh token when offline_access is granted;
 * otherwise it inserts NULL into every refresh_token_* column. Migration 469
 * created refresh_token_prefix as NOT NULL and migration 470 (which nulled the
 * sibling hash/expiry columns) missed it — so every non-offline_access exchange
 * hit a NOT-NULL violation AFTER the atomic consume UPDATE had already burned
 * the code, 500-ing the entire browser OAuth flow. PATs bypass issueTokens, so
 * unit tests (which mock the INSERT) never caught it; this exercises the real
 * schema. Migration 508 drops the stray NOT NULL.
 *
 * Runs against the real DB (only when DATABASE_URL is set — CI gates on that).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createHash } from 'crypto';
import { sql } from '@/lib/neon';
import { createAuthorisationCode, exchangeCode } from '@/lib/auth/oauth';

const COMPANY_ID = '00000000-0000-0000-0508-000000000001';
const USER_ID = '00000000-0000-0000-0508-000000000002';
const CLIENT_ID = 'client_mig508_test_fixture';
const REDIRECT = 'https://mig508.example/callback';

// A fixed PKCE pair — challenge is the S256 hash of the verifier, matching how
// exchangeCode recomputes it (base64url, no padding).
const VERIFIER = 'mig508-verifier-0123456789-abcdefghijklmnopqrstuvwxyz';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

let appId: string;

beforeAll(async () => {
  await sql`
    INSERT INTO companies (id, name, registration_number, created_at)
    VALUES (${COMPANY_ID}::uuid, 'Mig508 OAuth Test Co', 'MIG508-TEST', NOW())
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO users (id, email)
    VALUES (${USER_ID}, 'mig508-oauth@isaflow.test')
    ON CONFLICT (id) DO NOTHING
  `;
  const app = (await sql`
    INSERT INTO oauth_apps (name, redirect_uris, client_id, token_endpoint_auth_method)
    VALUES ('Mig508 Test App', ${[REDIRECT]}, ${CLIENT_ID}, 'none')
    ON CONFLICT (client_id) DO UPDATE SET updated_at = NOW()
    RETURNING id
  `) as Array<{ id: string }>;
  appId = app[0]!.id;
});

afterAll(async () => {
  // CASCADE from oauth_apps + companies clears codes/authorisations.
  await sql`DELETE FROM oauth_apps WHERE id = ${appId}::uuid`;
  await sql`DELETE FROM users WHERE id = ${USER_ID}`;
  await sql`DELETE FROM companies WHERE id = ${COMPANY_ID}::uuid`;
});

describe('OAuth exchange without offline_access (migration 508 regression)', () => {
  it('mints an oat_ access token and NO refresh token when offline_access is absent', async () => {
    const code = await createAuthorisationCode({
      oauthAppId: appId,
      userId: USER_ID,
      companyId: COMPANY_ID,
      redirectUri: REDIRECT,
      scopes: ['read:reports', 'write:journals', 'write:post'],
      codeChallenge: CHALLENGE,
    });

    const result = await exchangeCode({
      code,
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      oauthAppId: appId,
    });

    expect(result.accessToken).toMatch(/^oat_/);
    expect(result.refreshToken).toBe(''); // no offline_access ⇒ no ort_
    expect(result.scopes).toEqual(['read:reports', 'write:journals', 'write:post']);
  });

  it('still mints a refresh token when offline_access IS granted (positive control)', async () => {
    const code = await createAuthorisationCode({
      oauthAppId: appId,
      userId: USER_ID,
      companyId: COMPANY_ID,
      redirectUri: REDIRECT,
      scopes: ['read:reports', 'offline_access'],
      codeChallenge: CHALLENGE,
    });

    const result = await exchangeCode({
      code,
      redirectUri: REDIRECT,
      codeVerifier: VERIFIER,
      oauthAppId: appId,
    });

    expect(result.accessToken).toMatch(/^oat_/);
    expect(result.refreshToken).toMatch(/^ort_/);
  });
});
