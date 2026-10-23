// tests/integration/s07c-credential-paths.oauth.int.test.ts
//
// Audit 2026-10-18 S-07c: migration 930 takes INSERT and UPDATE on
// personal_access_tokens and the OAuth tables away from app_user, and the code
// now writes them on the migration_admin pool. This proves every legitimate
// credential path still works end to end through its real route, on the
// production logins (s07b helpers): PATs are minted, used and revoked; OAuth
// apps are registered (developer and RFC 7591), consented, exchanged, used,
// refreshed and revoked. DB state is read back on the superuser fixture.
// Nothing is stubbed: these routes make no GoTrue or email call.
// The other S-07c paths: s07c-credential-paths.int.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import patsRoute from '../../pages/api/auth/personal-tokens/index';
import patRoute from '../../pages/api/auth/personal-tokens/[id]';
import devAppsRoute from '../../pages/api/developer/oauth-apps/index';
import devAppRoute from '../../pages/api/developer/oauth-apps/[id]';
import registerRoute from '../../pages/api/oauth/register';
import consentRoute from '../../pages/api/oauth/consent';
import tokenRoute from '../../pages/api/oauth/token';
import authorisationRoute from '../../pages/api/oauth/authorisations/[id]';
import captureKeysRoute from '../../pages/api/accounting/capture/api-keys/index';
import captureKeyRevokeRoute from '../../pages/api/accounting/capture/api-keys/[id]/revoke';
import { validateCaptureApiKey } from '@/lib/auth/captureApiKeyAuth';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { oauthIssuer } from '@/lib/auth/oauthResource';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';
import { callPublic, clearRateLimits, mcpPing, poll, sha256 } from './s07c-credential-paths.helpers';

const ids = newIds();
const { me, company } = ids;
const appIds: string[] = [];

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('MCP_DCR_ENABLED', 'true');
}, 60000);
afterAll(async () => {
  await fixture.query('DELETE FROM oauth_apps WHERE id = ANY($1::uuid[]) OR owner_user_id = $2', [appIds, me]);
  await fixture.query('DELETE FROM capture_api_keys WHERE company_id = $1', [company]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});
beforeEach(() => clearRateLimits());

const row = async (table: string, id: string) =>
  (await fixture.query(`SELECT * FROM ${table} WHERE id = $1`, [id])).rows[0] as Record<string, unknown>;

describe('S-07c: a personal access token is minted, used and revoked through its routes', () => {
  let pat = { id: '', token: '' };

  it('POST /api/auth/personal-tokens mints a token (migration_admin INSERT) bound to the caller and company', async () => {
    const r = await callRoute(patsRoute, { sub: me, method: 'POST', companyId: company,
      body: { name: 's07c pat', scopes: ['read:reports'], expiresInDays: 7 } });
    expect(r.status).toBe(201);
    pat = (r.body as { data: { id: string; token: string } }).data;
    expect(pat.token).toMatch(/^pat_[A-Za-z0-9]{32}$/);
    expect(await row('personal_access_tokens', pat.id)).toMatchObject({
      user_id: me, company_id: company, token_hash: sha256(pat.token), scopes: ['read:reports'], revoked_at: null });
  });

  it('the token answers an MCP ping, and validation stamps last_used_at', async () => {
    expect(await mcpPing(pat.token)).toMatchObject({ status: 200, body: { id: 1, result: {} } });
    const used = await poll(async () => (await row('personal_access_tokens', pat.id)).last_used_at);
    expect(used).toBeInstanceOf(Date);
  });

  it('DELETE /api/auth/personal-tokens/[id] revokes it, and the bearer is then refused', async () => {
    const r = await callRoute(patRoute, { sub: me, method: 'DELETE', companyId: company, query: { id: pat.id } });
    expect(r).toMatchObject({ status: 200, body: { data: { revoked: true } } });
    expect((await row('personal_access_tokens', pat.id)).revoked_at).toBeInstanceOf(Date);
    expect((await mcpPing(pat.token)).status).toBe(401);
  });
});

// capture_api_keys joined 930 after breaker round 1: a key with no creator acts as manager.
describe('S-07c: a capture API key is minted, used and revoked through its routes', () => {
  let key = { id: '', key: '' };

  it('POST /api/accounting/capture/api-keys mints a key (migration_admin INSERT) created by the caller', async () => {
    const r = await callRoute(captureKeysRoute, { sub: me, method: 'POST', companyId: company, body: { label: 's07c key' } });
    expect(r.status).toBe(201);
    key = (r.body as { data: { id: string; key: string } }).data;
    expect(await row('capture_api_keys', key.id)).toMatchObject({
      company_id: company, created_by: me, key_hash: sha256(key.key), is_active: true, revoked_at: null });
  });

  it('the key validates as its creator\'s role, and validation stamps last_used_at (service pool, 930\'s column grant)', async () => {
    expect(await validateCaptureApiKey(key.key)).toMatchObject({ companyId: company, keyId: key.id, role: 'admin' });
    expect(await poll(async () => (await row('capture_api_keys', key.id)).last_used_at)).toBeInstanceOf(Date);
  });

  it('POST /api/accounting/capture/api-keys/[id]/revoke revokes it (migration_admin), and it no longer validates', async () => {
    const r = await callRoute(captureKeyRevokeRoute, { sub: me, method: 'POST', companyId: company, query: { id: key.id } });
    expect(r.status).toBe(200);
    expect(await row('capture_api_keys', key.id)).toMatchObject({ is_active: false });
    expect(await validateCaptureApiKey(key.key)).toBeNull();
  });
});

const REDIRECT = 'https://s07c.example/callback';
const LOOPBACK = 'http://127.0.0.1:7777/callback';
const resource = () => `${oauthIssuer()}/api/mcp`;

/** Consent as `me` in `company` with a fresh PKCE pair; returns the code and its verifier. */
async function consent(clientId: string, redirectUri: string): Promise<{ code: string; verifier: string }> {
  const verifier = randomBytes(32).toString('base64url');
  const r = await callRoute(consentRoute, { sub: me, method: 'POST', companyId: company, body: {
    clientId, redirectUri, state: 's07c', codeChallenge: createHash('sha256').update(verifier).digest('base64url'),
    codeChallengeMethod: 'S256', scopes: ['read:reports', 'offline_access'], resource: resource() } });
  expect(r.status).toBe(200);
  const to = new URL((r.body as { data: { redirectTo: string } }).data.redirectTo);
  expect(to.searchParams.get('state')).toBe('s07c');
  const code = to.searchParams.get('code')!;
  const stored = await fixture.query('SELECT user_id, company_id, scopes, used_at FROM oauth_authorisation_codes WHERE code_hash = $1',
    [sha256(code)]);
  expect(stored.rows).toEqual([{ user_id: me, company_id: company, scopes: ['read:reports', 'offline_access'], used_at: null }]);
  return { code, verifier };
}

const token = (body: Record<string, string>) => callPublic(tokenRoute, { body: { ...body, resource: resource() } });
type Tokens = { access_token: string; refresh_token: string };

const authorisation = async (appId: string) => (await fixture.query(
  'SELECT * FROM oauth_authorisations WHERE oauth_app_id = $1 AND user_id = $2 AND company_id = $3', [appId, me, company],
)).rows[0] as Record<string, unknown>;

describe('S-07c: a developer (confidential) OAuth app, from registration to revocation', () => {
  let app = { id: '', clientId: '', clientSecret: '' };
  let tokens: Tokens = { access_token: '', refresh_token: '' };

  it('POST /api/developer/oauth-apps registers it (migration_admin INSERT) with a secret', async () => {
    const r = await callRoute(devAppsRoute, { sub: me, method: 'POST', companyId: company,
      body: { name: 'S07c developer app', redirectUris: [REDIRECT] } });
    expect(r.status).toBe(201);
    app = (r.body as { data: typeof app }).data;
    appIds.push(app.id);
    expect(await row('oauth_apps', app.id)).toMatchObject({ owner_user_id: me, client_id: app.clientId,
      client_secret_hash: sha256(app.clientSecret), is_dynamic: false, revoked_at: null });
  });

  it('consent mints a code, and the code (with secret and verifier) exchanges for tokens that answer MCP', async () => {
    const { code, verifier } = await consent(app.clientId, REDIRECT);
    const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier,
      client_id: app.clientId, client_secret: app.clientSecret });
    expect(r.status).toBe(200);
    tokens = r.body as Tokens;
    expect(tokens.access_token).toMatch(/^oat_/);
    expect(tokens.refresh_token).toMatch(/^ort_/);
    expect((await fixture.query('SELECT used_at FROM oauth_authorisation_codes WHERE code_hash = $1', [sha256(code)])).rows[0].used_at)
      .toBeInstanceOf(Date);
    expect(await authorisation(app.id)).toMatchObject({ access_token_hash: sha256(tokens.access_token),
      refresh_token_hash: sha256(tokens.refresh_token), revoked_at: null });
    expect(await mcpPing(tokens.access_token)).toMatchObject({ status: 200, body: { id: 1, result: {} } });
    expect(await poll(async () => (await authorisation(app.id)).last_used_at)).toBeInstanceOf(Date);
  });

  it('refresh (confidential: client_secret required) rotates both tokens; the old access token stops working', async () => {
    const without = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: app.clientId });
    expect(without.status).toBe(401);
    const r = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
      client_id: app.clientId, client_secret: app.clientSecret });
    expect(r.status).toBe(200);
    const next = r.body as Tokens;
    expect(await authorisation(app.id)).toMatchObject({ access_token_hash: sha256(next.access_token),
      refresh_token_hash: sha256(next.refresh_token), previous_refresh_token_hash: sha256(tokens.refresh_token) });
    expect((await mcpPing(tokens.access_token)).status).toBe(401);
    expect((await mcpPing(next.access_token)).status).toBe(200);
    tokens = next;
  });

  it('DELETE /api/oauth/authorisations/[id] revokes the grant, and its token is refused', async () => {
    const { id } = await authorisation(app.id) as { id: string };
    const r = await callRoute(authorisationRoute, { sub: me, method: 'DELETE', companyId: company, query: { id } });
    expect(r).toMatchObject({ status: 200, body: { data: { revoked: true } } });
    expect((await authorisation(app.id)).revoked_at).toBeInstanceOf(Date);
    expect((await mcpPing(tokens.access_token)).status).toBe(401);
  });

  it('DELETE /api/developer/oauth-apps/[id] revokes the app; its client is then unknown to the token route', async () => {
    const r = await callRoute(devAppRoute, { sub: me, method: 'DELETE', companyId: company, query: { id: app.id } });
    expect(r).toMatchObject({ status: 200, body: { data: { revoked: true } } });
    expect((await row('oauth_apps', app.id)).revoked_at).toBeInstanceOf(Date);
    const t = await token({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token,
      client_id: app.clientId, client_secret: app.clientSecret });
    expect(t).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
  });
});

describe('S-07c: a dynamically registered (public) client, with PKCE and no secret', () => {
  let clientId = '';
  let appId = '';

  it('POST /api/oauth/register creates a public client (migration_admin INSERT)', async () => {
    const r = await callPublic(registerRoute, { body: { client_name: 'S07c DCR client', redirect_uris: [LOOPBACK] } });
    expect(r).toMatchObject({ status: 201, body: { token_endpoint_auth_method: 'none', redirect_uris: [LOOPBACK] } });
    clientId = (r.body as { client_id: string }).client_id;
    const stored = await fixture.query('SELECT id, owner_user_id, client_secret_hash, is_dynamic FROM oauth_apps WHERE client_id = $1',
      [clientId]);
    expect(stored.rows).toMatchObject([{ owner_user_id: null, client_secret_hash: null, is_dynamic: true }]);
    appId = stored.rows[0].id as string;
    appIds.push(appId);
  });

  it('consent, exchange without a secret, MCP use, and a refresh without a secret all work', async () => {
    const { code, verifier } = await consent(clientId, LOOPBACK);
    const wrong = await token({ grant_type: 'authorization_code', code, redirect_uri: LOOPBACK,
      code_verifier: `${verifier}x`, client_id: clientId });
    expect(wrong).toMatchObject({ status: 400, body: { error: 'invalid_grant' } });
    const r = await token({ grant_type: 'authorization_code', code, redirect_uri: LOOPBACK, code_verifier: verifier, client_id: clientId });
    expect(r.status).toBe(200);
    const first = r.body as Tokens;
    expect((await mcpPing(first.access_token)).status).toBe(200);
    const refreshed = await token({ grant_type: 'refresh_token', refresh_token: first.refresh_token, client_id: clientId });
    expect(refreshed.status).toBe(200);
    const next = refreshed.body as Tokens;
    expect(await authorisation(appId)).toMatchObject({ access_token_hash: sha256(next.access_token), revoked_at: null });
    expect((await mcpPing(next.access_token)).status).toBe(200);
  });
});
