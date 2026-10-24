// tests/integration/s07c-credential-writes.int.test.ts
//
// S-07c B (migration 930): SQL injected on either app pool can forge
// request.jwt.claims and app.current_company_id, and the RLS policies on these
// tables admitted any row the forged claims named. Each statement below would
// mint a credential, a membership or a role, or read what one is made of; each
// must now be refused by privilege, on the logins production has:
//   - isaflow_app inside a request (SET LOCAL ROLE app_user) under a victim's
//     forged claims;
//   - isaflow_service with no claims;
//   - either, after set_config('role', 'none'), the S-07 bypass of a
//     current_user check.
// The legitimate paths, on the migration_admin pool: s07c-credential-paths*.
// The migration and its every-deploy rules: s07c-credential-writes.migration.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { attempt, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
// owner is the victim; invitee, a member of nothing, is the attacker.
const { owner, invitee, company, other } = ids;
const stash = crypto.randomUUID();

beforeAll(async () => {
  await setup(ids);
  await fixture.query(`INSERT INTO admin_impersonation_stash (stash_id, admin_user_id, admin_access_token, admin_refresh_token,
    target_user_id, expires_at) VALUES ($1, $2, 'enc-a', 'enc-r', $3, NOW() + interval '1 hour')`, [stash, ids.admin, ids.me]);
  await fixture.query(`INSERT INTO auth_password_reset_tokens (user_id, token_hash, expires_at)
    VALUES ($1, 's07c-reset', NOW() + interval '1 hour')`, [owner]);
  await fixture.query(`UPDATE personal_access_tokens SET revoked_at = NOW() WHERE user_id = $1`, [ids.me]);
}, 60000);

afterAll(async () => {
  await fixture.query('DELETE FROM admin_impersonation_stash WHERE stash_id = $1', [stash]);
  await fixture.query('DELETE FROM auth_password_reset_tokens WHERE user_id = $1', [owner]);
  await teardown(ids, [getAuthPool(), getDbPool()]);
});

const denied = (table: string) => ({ code: '42501', message: `permission denied for table ${table}` });

/** [what it would do, table, statement, params] */
type Mint = [string, string, string, () => unknown[]];
const MINTS: Mint[] = [
  ['a PAT for the victim', 'personal_access_tokens', `INSERT INTO personal_access_tokens (user_id, company_id, token_hash, token_prefix,
    name, scopes, expires_at) VALUES ($1, $2, 'forged', 'pat_forged', 'x', '{read:reports}', NOW() + interval '1 day')`, () => [owner, company]],
  ['a revoked PAT revived', 'personal_access_tokens', 'UPDATE personal_access_tokens SET revoked_at = NULL WHERE user_id = $1', () => [ids.me]],
  ['a PAT re-keyed to a known hash', 'personal_access_tokens', `UPDATE personal_access_tokens SET token_hash = 'known' WHERE user_id = $1`,
    () => [ids.me]],
  ['an OAuth grant for the victim', 'oauth_authorisations', `INSERT INTO oauth_authorisations (oauth_app_id, user_id, company_id, scopes,
    access_token_hash, access_token_expires_at) VALUES (gen_random_uuid(), $1, $2, '{read:reports}', 'forged', NOW() + interval '1 hour')`,
  () => [owner, company]],
  ['an OAuth grant re-keyed', 'oauth_authorisations', `UPDATE oauth_authorisations SET access_token_hash = 'known' WHERE user_id = $1`,
    () => [owner]],
  ['an OAuth grant revived', 'oauth_authorisations', 'UPDATE oauth_authorisations SET revoked_at = NULL WHERE user_id = $1', () => [owner]],
  ['an authorisation code for the victim', 'oauth_authorisation_codes', `INSERT INTO oauth_authorisation_codes (code_hash, oauth_app_id,
    user_id, company_id, redirect_uri, scopes, code_challenge, expires_at)
    VALUES ('forged', gen_random_uuid(), $1, $2, 'https://evil.test/cb', '{read:reports}', 'c', NOW() + interval '5 minutes')`,
  () => [owner, company]],
  ['an authorisation code re-opened', 'oauth_authorisation_codes', 'UPDATE oauth_authorisation_codes SET used_at = NULL WHERE user_id = $1',
    () => [owner]],
  ['an OAuth app owned by the victim', 'oauth_apps', `INSERT INTO oauth_apps (name, redirect_uris, client_id, owner_user_id)
    VALUES ('forged', ARRAY['https://evil.test/cb'], 'client_forged_s07c', $1)`, () => [owner]],
  ['an OAuth app re-pointed', 'oauth_apps', `UPDATE oauth_apps SET redirect_uris = ARRAY['https://evil.test/cb'] WHERE owner_user_id = $1`,
    () => [owner]],
  ['an owner invitation to a company the attacker is not in', 'company_invitations', `INSERT INTO company_invitations
    (company_id, email, role, invited_by, token, expires_at) VALUES ($1, $2, 'owner', $3, 'forged', NOW() + interval '1 day')`,
  () => [company, `${invitee}@test.local`, owner]],
  ['an invitation re-pointed to the attacker', 'company_invitations', 'UPDATE company_invitations SET email = $2 WHERE company_id = $1',
    () => [company, `${invitee}@test.local`]],
  ['the attacker made an owner', 'company_users', `INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')`,
    () => [company, invitee]],
  ['the victim\'s membership moved to the attacker', 'company_users', 'UPDATE company_users SET user_id = $2 WHERE user_id = $1',
    () => [owner, invitee]],
  ['a password reset token for the victim', 'auth_password_reset_tokens', `INSERT INTO auth_password_reset_tokens (user_id, token_hash,
    expires_at) VALUES ($1, 'forged', NOW() + interval '1 hour')`, () => [owner]],
  ['a password reset token revived', 'auth_password_reset_tokens', 'UPDATE auth_password_reset_tokens SET consumed_at = NULL WHERE user_id = $1',
    () => [owner]],
  ['the reset token hashes read', 'auth_password_reset_tokens', 'SELECT token_hash FROM auth_password_reset_tokens WHERE user_id = $1',
    () => [owner]],
  ['an admin\'s stash re-targeted at the attacker', 'admin_impersonation_stash',
    'UPDATE admin_impersonation_stash SET target_user_id = $2 WHERE stash_id = $1', () => [stash, invitee]],
  ['an admin\'s stash read', 'admin_impersonation_stash', 'SELECT stash_id FROM admin_impersonation_stash', () => []],
  ['the waitlist read', 'waitlist_signups', 'SELECT email FROM waitlist_signups', () => []],
  ['a signup altered', 'waitlist_signups', `UPDATE waitlist_signups SET email = 'x@evil.test'`, () => []],
  ['a signup removed', 'waitlist_signups', 'DELETE FROM waitlist_signups', () => []],
  ['a signup planted as promoted', 'waitlist_signups', `INSERT INTO waitlist_signups (email, promoted_company_id)
    VALUES ('planted@evil.test', $1)`, () => [company]],
  ['the matview throttle reset', 'matview_refresh_state', 'DELETE FROM matview_refresh_state', () => []],
  // No creator: validateCaptureApiKey admits it as manager, for any company.
  ['a capture key for another company', 'capture_api_keys', `INSERT INTO capture_api_keys (company_id, label, key_hash, key_prefix)
    VALUES ($1, 'forged', 'forged-hash', 'isa_live_fo')`, () => [other]],
  ['a revoked capture key revived', 'capture_api_keys', 'UPDATE capture_api_keys SET is_active = true, revoked_at = NULL WHERE company_id = $1',
    () => [company]],
];

const pools: Array<[string, () => Pool, Parameters<typeof attempt>[2]]> = [
  ['isaflow_app under the victim\'s forged claims', getAuthPool, { asRequest: { sub: owner, companyId: company } }],
  ['isaflow_service with no claims', getDbPool, {}],
  ['isaflow_service under the victim\'s forged claims', getDbPool, { claims: { sub: owner, companyId: other } }],
];

describe.each(pools)('S-07c (930): %s', (_, pool, opts) => {
  it.each(MINTS)('cannot write %s', async (_what, table, text, params) => {
    expect(await attempt(pool(), [[text, params()]], opts)).toEqual(denied(table));
  });

  // The first mint of each table: the S-07 bypass of a current_user check.
  const firstPerTable = MINTS.filter(([, t], i) => MINTS.findIndex(([, u]) => u === t) === i);
  it.each(firstPerTable)(
    'cannot write %s after set_config(role, none) either', async (_what, table, text, params) => {
      const r = await attempt(pool(), [[`SELECT set_config('role', 'none', true)`], [text, params()]], opts);
      // isaflow_app inherits nothing, so it has no privilege on the table at all.
      expect(r).toEqual(denied(table));
    });
});

describe('S-07c (930): what an app role may still write', () => {
  // 930 kept a member's role here (the residual); 935 closed it: s07d-credential-tables.int.test.ts.
  it('no longer a member\'s role (935)', async () => {
    const r = await attempt(getAuthPool(), [[`UPDATE company_users SET role = 'manager' WHERE company_id = $1 AND user_id = $2`,
      [company, ids.me]]], { asRequest: { sub: owner, companyId: company } });
    expect(r).toEqual(denied('company_users'));
  });

  it.each([
    ['personal_access_tokens', `UPDATE personal_access_tokens SET last_used_at = NOW(), last_used_ip = '127.0.0.1' WHERE user_id = $1`],
    ['oauth_authorisations', `UPDATE oauth_authorisations SET last_used_at = NOW(), last_used_ip = '127.0.0.1' WHERE user_id = $1`],
    ['capture_api_keys', 'UPDATE capture_api_keys SET last_used_at = NOW() WHERE created_by = $1'],
  ])('the last-used stamp on %s, on the service pool', async (_, text) => {
    expect(await attempt(getDbPool(), [[text, [ids.me]]])).toBeNull();
  });

  it('a waitlist signup, on the service pool, as the form writes it: no RETURNING, no conflict target', async () => {
    expect(await attempt(getDbPool(), [[`INSERT INTO waitlist_signups (name, email, signup_type) VALUES ('S07c', $1, 'direct')
      ON CONFLICT DO NOTHING`, [`${invitee}-wl@test.local`]]])).toBeNull();
  });

  it.each([
    ['cancel an invitation', 'DELETE FROM company_invitations WHERE company_id = $1', () => [company]],
    ['revoke-delete a PAT', 'DELETE FROM personal_access_tokens WHERE user_id = $1', () => [ids.me]],
  ])('%s by DELETE (removes access only)', async (_, text, params) => {
    expect(await attempt(getAuthPool(), [[text, params()]], { asRequest: { sub: ids.me, companyId: company } })).toBeNull();
  });
});
