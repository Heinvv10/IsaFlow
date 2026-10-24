// tests/integration/s07d-credential-tables.int.test.ts
//
// S-07d (migration 935): the tables S-07c's class sweep left on the app pools.
// SQL injected on either pool can forge request.jwt.claims and
// app.current_company_id, and every policy below admitted the row the forged
// claims named (app_service's mirrors admit every row). Each statement here
// would mint, revive, re-key or read a credential, a role or a route that a
// privileged path later honours; each must now be refused by privilege, on the
// logins production has, as in s07c-credential-writes.int.test.ts:
//   company_users              a member makes itself owner, or an owner's
//                              forged claims remove the other members;
//   portal_magic_links         an AFS portal session for any contact;
//   portal_contacts            who may ask for one, and with which role;
//   portal_access              an AR portal login with a known password;
//   share_links                a read link to any company's reports;
//   audit_portal_sessions      an auditor download of any company's pack;
//   capture_whatsapp_claims,
//   capture_inboxes            where a company's emailed or WhatsApp documents go;
//   bank_feed_connections      a revoked extension pairing revived.
// The legitimate paths, on the migration_admin pool: s07d-credential-paths*.
// The migration and its rules: s07d-credential-tables.migration.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { attempt, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
// owner is the victim's owner, me an admin of the victim's company, invitee the
// attacker; other is a second tenant.
const { owner, invitee, company, other, me } = ids;

beforeAll(() => setup(ids), 60000);
afterAll(() => teardown(ids, [getAuthPool(), getDbPool()]));

const denied = (table: string) => ({ code: '42501', message: `permission denied for table ${table}` });
const uuid = () => crypto.randomUUID();

/** [what it would do, table, statement, params] */
type Mint = [string, string, string, () => unknown[]];
const MINTS: Mint[] = [
  ['a membership raised to owner', 'company_users', `UPDATE company_users SET role = 'owner' WHERE company_id = $1 AND user_id = $2`,
    () => [company, me]],
  ['the other members and owners removed', 'company_users', 'DELETE FROM company_users WHERE company_id = $1 AND user_id <> $2',
    () => [company, owner]],
  ['an AFS portal link for any contact', 'portal_magic_links', `INSERT INTO portal_magic_links (company_id, contact_id, token, expires_at)
    VALUES ($1, $2, 'forged-portal-token', NOW() + interval '30 minutes')`, () => [other, uuid()]],
  ['an AFS portal link revived', 'portal_magic_links', 'UPDATE portal_magic_links SET used_at = NULL WHERE company_id = $1', () => [other]],
  ['the raw AFS portal tokens read', 'portal_magic_links', 'SELECT token FROM portal_magic_links WHERE company_id = $1', () => [other]],
  ['an AFS portal contact planted', 'portal_contacts', `INSERT INTO portal_contacts (company_id, name, email, role)
    VALUES ($1, 'Forged', 'attacker@evil.test', 'director')`, () => [other]],
  ['an AFS portal contact re-addressed', 'portal_contacts', `UPDATE portal_contacts SET email = 'attacker@evil.test' WHERE company_id = $1`,
    () => [other]],
  ['an AFS portal contact revived', 'portal_contacts', 'UPDATE portal_contacts SET active = true WHERE company_id = $1', () => [other]],
  ['an AR portal login with a known password', 'portal_access', `INSERT INTO portal_access (client_id, email, password_hash, name)
    VALUES ($1, 'attacker@evil.test', '$2a$12$known', 'Forged')`, () => [uuid()]],
  ['an AR portal password re-set', 'portal_access', `UPDATE portal_access SET password_hash = '$2a$12$known'`, () => []],
  ['the AR portal password hashes read', 'portal_access', 'SELECT password_hash FROM portal_access', () => []],
  ['an AR portal login revived', 'portal_access', 'UPDATE portal_access SET is_active = true', () => []],
  ['a report share link for any company', 'share_links', `INSERT INTO share_links (company_id, report_kind, params, token_hash, created_by)
    VALUES ($1, 'pack', '{}', 'forged-hash', $2)`, () => [other, invitee]],
  ['a share link revived', 'share_links', 'UPDATE share_links SET revoked_at = NULL WHERE company_id = $1', () => [other]],
  ['a share link extended', 'share_links', `UPDATE share_links SET expires_at = NOW() + interval '10 years' WHERE company_id = $1`,
    () => [other]],
  ['a share link re-keyed', 'share_links', `UPDATE share_links SET token_hash = 'known' WHERE company_id = $1`, () => [other]],
  ['an auditor session for any export', 'audit_portal_sessions', `INSERT INTO audit_portal_sessions
    (export_id, company_id, auditor_email, token_hash, expires_at) VALUES ($1, $2, 'attacker@evil.test', '$2a$10$known',
    NOW() + interval '7 days')`, () => [uuid(), other]],
  ['an auditor session re-keyed', 'audit_portal_sessions', `UPDATE audit_portal_sessions SET token_hash = '$2a$10$known'
    WHERE company_id = $1`, () => [other]],
  ['an auditor session revived', 'audit_portal_sessions', 'UPDATE audit_portal_sessions SET revoked_at = NULL WHERE company_id = $1',
    () => [other]],
  ['a WhatsApp claim for any company', 'capture_whatsapp_claims', `INSERT INTO capture_whatsapp_claims
    (company_id, address, token_hash, created_by, expires_at) VALUES ($1, '+27820000000', 'forged', $2, NOW() + interval '1 day')`,
  () => [other, owner]],
  ['a WhatsApp claim re-keyed', 'capture_whatsapp_claims', `UPDATE capture_whatsapp_claims SET token_hash = 'known' WHERE company_id = $1`,
    () => [other]],
  ['a capture inbox planted on another company\'s address', 'capture_inboxes', `INSERT INTO capture_inboxes
    (company_id, channel, address, is_active) VALUES ($1, 'email', 'victim@capture.test', true)`, () => [company]],
  ['a capture inbox re-addressed', 'capture_inboxes', `UPDATE capture_inboxes SET address = 'victim@capture.test' WHERE company_id = $1`,
    () => [company]],
  ['a capture inbox\'s webhook token re-keyed', 'capture_inboxes', `UPDATE capture_inboxes SET webhook_token_hash = 'known'
    WHERE company_id = $1`, () => [other]],
  ['a capture inbox switched off', 'capture_inboxes', 'UPDATE capture_inboxes SET is_active = false WHERE company_id = $1', () => [other]],
  ['a revoked extension pairing revived', 'bank_feed_connections', `UPDATE bank_feed_connections SET is_active = true
    WHERE company_id = $1`, () => [other]],
  ['a revoked pairing re-created under its old id', 'bank_feed_connections', `INSERT INTO bank_feed_connections
    (id, company_id, bank_account_id, provider, is_active) VALUES ($1, $2, $3, 'extension', true)`, () => [uuid(), other, uuid()]],
];

const pools: Array<[string, () => Pool, Parameters<typeof attempt>[2]]> = [
  // The attacker's forged claims: an owner of the victim's company.
  ['isaflow_app under the victim owner\'s forged claims', getAuthPool, { asRequest: { sub: owner, companyId: company } }],
  ['isaflow_service with no claims', getDbPool, {}],
  ['isaflow_service under forged claims', getDbPool, { claims: { sub: owner, companyId: other } }],
];

describe.each(pools)('S-07d (935): %s', (_, pool, opts) => {
  it.each(MINTS)('cannot write %s', async (_what, table, text, params) => {
    expect(await attempt(pool(), [[text, params()]], opts)).toEqual(denied(table));
  });

  const firstPerTable = MINTS.filter(([, t], i) => MINTS.findIndex(([, u]) => u === t) === i);
  it.each(firstPerTable)('cannot write %s after set_config(role, none) either', async (_what, table, text, params) => {
    expect(await attempt(pool(), [[`SELECT set_config('role', 'none', true)`], [text, params()]], opts)).toEqual(denied(table));
  });
});

describe('S-07d (935): what an app role may still do', () => {
  it.each([
    ['a share link view counted', 'UPDATE share_links SET view_count = view_count + 1, last_viewed_at = NOW() WHERE company_id = $1'],
    ['an auditor session use stamped', 'UPDATE audit_portal_sessions SET last_used_at = NOW(), use_count = use_count + 1 WHERE company_id = $1'],
    ['a bank feed sync stamped', `UPDATE bank_feed_connections SET last_sync_at = NOW(), last_success_at = NOW(), last_sync_status = 'success',
      last_sync_error = NULL, last_scraper_version = '1', scraper_version = '1', updated_at = NOW() WHERE company_id = $1`],
    ['an AR portal session checked', `SELECT pa.id, pa.client_id, pa.email, pa.name, pa.is_active, pa.last_login_at, pa.created_at,
      pa.updated_at FROM portal_access pa WHERE pa.client_id = $1`],
  ])('%s, on the service pool', async (_, text) => {
    expect(await attempt(getDbPool(), [[text, [other]]])).toBeNull();
  });

  it.each([
    ['an AFS portal contact read', 'SELECT id, email, role, active FROM portal_contacts WHERE company_id = $1'],
    ['a share link deleted (removes access only)', 'DELETE FROM share_links WHERE company_id = $1'],
    ['an AR portal login deleted (removes access only)', 'DELETE FROM portal_access WHERE client_id = $1'],
  ])('%s, in a request', async (_, text) => {
    const params = text.includes('$2') ? [company, me] : [company];
    expect(await attempt(getAuthPool(), [[text, params]], { asRequest: { sub: owner, companyId: company } })).toBeNull();
  });
});
