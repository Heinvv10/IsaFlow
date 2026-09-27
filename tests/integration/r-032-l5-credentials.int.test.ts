/**
 * R-032 re-check HIGH: a "Login as" session mints no credential as the target.
 *
 * Bearer calls (MCP/OAuth, PATs, the extension) carry no GoTrue session id, so
 * the approval guards read them as `unknown` and let them through — correctly,
 * for a credential the user minted. A credential the ADMIN minted while
 * impersonating would inherit that pass and approve, post or close as the
 * target for up to a year. So every cookie route that mints a bearer
 * credential refuses a Login-as session: 403 IMPERSONATION_FORBIDDEN, nothing
 * created. The target's own session still mints.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { NextApiHandler } from 'next';
import personalTokens from '../../pages/api/auth/personal-tokens/index';
import oauthConsent from '../../pages/api/oauth/consent';
import developerApps from '../../pages/api/developer/oauth-apps/index';
import extensionPair from '../../pages/api/accounting/bank-feeds/extension-pair';
import captureApiKeys from '../../pages/api/accounting/capture/api-keys/index';
import { registerOauthApp } from '@/lib/auth/oauth';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { loginAsFixture, reasonOf, type Call, type Jar } from './r-032-login-as.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const fx = loginAsFixture(pool, 'R032 creds');
const REDIRECT = 'https://connector.r032.example/callback';
let clientId = '';
let appId = '';

beforeAll(async () => {
  await fx.setUp();
  // A dynamic (RFC 7591) client, as an MCP connector registers itself — readable by any member at consent.
  const app = await registerOauthApp({ ownerUserId: null, dynamic: true, name: 'R032 connector', redirectUris: [REDIRECT] });
  clientId = app.clientId;
  appId = app.id;
});
afterAll(async () => {
  try {
    await pool.query('DELETE FROM personal_access_tokens WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM oauth_authorisation_codes WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM oauth_apps WHERE id=$1 OR owner_user_id=$2', [appId, fx.target]);
    await pool.query('DELETE FROM capture_api_keys WHERE company_id=$1', [fx.company]);
    await pool.query('DELETE FROM bank_feed_connections WHERE company_id=$1', [fx.company]);
    await fx.tearDown();
  } finally { await pool.end(); }
});

const credentials = async () => (await pool.query(`SELECT
    (SELECT count(*) FROM personal_access_tokens WHERE user_id=$2) AS pats,
    (SELECT count(*) FROM oauth_authorisation_codes WHERE user_id=$2) AS oauth_codes,
    (SELECT count(*) FROM oauth_apps WHERE owner_user_id=$2) AS developer_apps,
    (SELECT count(*) FROM capture_api_keys WHERE company_id=$1) AS capture_keys,
    (SELECT count(*) FROM bank_feed_connections WHERE company_id=$1) AS extension_pairings`,
[fx.company, fx.target])).rows[0];

type Case = { name: string; handler: NextApiHandler; call: () => Call; mints?: boolean };
const CASES: Case[] = [
  { name: 'personal access token create', handler: personalTokens, mints: true,
    call: () => ({ body: { name: 'r032', scopes: ['read:invoices'], expiresInDays: 30 } }) },
  { name: 'OAuth / MCP connector consent', handler: oauthConsent, mints: true,
    call: () => ({ body: { clientId, redirectUri: REDIRECT, codeChallenge: 'r032-pkce-challenge', codeChallengeMethod: 'S256',
      scopes: ['read:invoices'], state: 's' } }) },
  { name: 'developer OAuth app create', handler: developerApps, mints: true,
    call: () => ({ body: { name: 'R032 dev app', redirectUris: ['https://dev.r032.example/cb'] } }) },
  { name: 'capture API key create', handler: captureApiKeys, mints: true, call: () => ({ body: { label: 'r032' } }) },
  { name: 'browser-extension pairing', handler: extensionPair,
    call: () => ({ body: { bankId: 'absa', bankAccountId: crypto.randomUUID(), externalAccountId: '12345678' } }) },
];

describe('R-032 — a Login-as session mints no bearer credential', () => {
  let loginAs: Jar;
  beforeAll(async () => { loginAs = await fx.loginAsTarget(); });

  it.each(CASES)('refuses $name with 403 and creates nothing', async ({ handler, call }) => {
    const before = await credentials();
    const result = await fx.call(handler, loginAs, call());
    expect(result.state.statusCode, JSON.stringify(result.state.body)).toBe(403);
    expect(reasonOf(result)).toBe('IMPERSONATION_FORBIDDEN');
    expect(await credentials()).toEqual(before);
  });

  it.each(CASES)('lets the target\'s own session reach $name', async ({ handler, call, mints }) => {
    const before = await credentials();
    const result = await fx.call(handler, await fx.ownSession(), call());
    expect(reasonOf(result), JSON.stringify(result.state.body)).not.toBe('IMPERSONATION_FORBIDDEN');
    if (mints) {
      expect(result.state.statusCode, JSON.stringify(result.state.body)).toBeLessThan(300);
      expect(await credentials()).not.toEqual(before);
    }
  });
});
