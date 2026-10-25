// tests/integration/s07e-b-routes-paths-cap.int.test.ts
//
// S-07e part B, review round 8, on a real database and the production logins: a company holds at most
// MAX_ACTIVE_CONNECTIONS_PER_COMPANY (5) active connections per mirror. The count and the INSERT run in
// one routeAdminTx behind a per-company advisory lock (mirrorLimits.assertUnderConnectionCap), so
// concurrent creates cannot overshoot. The due selection's per-company rule is in
// s07e-b-routes-paths-due.int.test.ts.
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { routeAdminPool } from '@/lib/auth/routeAdminPool';
import { createImapConnection } from '@/modules/accounting/services/capture/mirrorConnectionService';
import { createSentImapConnection } from '@/modules/accounting/services/ar/sentMirrorAdmin';
import { MAX_ACTIVE_CONNECTIONS_PER_COMPANY, MirrorConnectionCapError, assertUnderConnectionCap } from '@/modules/accounting/services/capture/mirrorLimits';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

vi.stubEnv('ENCRYPTION_KEY', 'k'.repeat(36));

const ids = newIds();
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const TABLES = ['imap_mirror_connections', 'sent_mirror_connections'];

/** Companies of their own (the fixture has only `company` and `other`). */
const extraCompanies: string[] = [];
const newCompany = async (): Promise<string> => {
  const id = crypto.randomUUID();
  await q('INSERT INTO companies (id, name, is_active) VALUES ($1, $2, true)', [id, `s07eb-cap-${id.slice(0, 8)}`]);
  extraCompanies.push(id);
  return id;
};
const dropExtraCompanies = async (): Promise<void> => {
  for (const table of TABLES) await q(`DELETE FROM ${table} WHERE company_id = ANY($1)`, [extraCompanies]);
  await q('DELETE FROM companies WHERE id = ANY($1)', [extraCompanies]);
  extraCompanies.length = 0;
};

beforeAll(async () => { await setup(ids); }, 60000);
afterAll(async () => {
  await dropExtraCompanies();
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool(), routeAdminPool()]);
});

const CREATORS = [
  ['capture mirror', 'imap_mirror_connections', (co: string, n: string) => createImapConnection({ companyId: co, displayName: n, accountEmail: `${n}@s07eb.test`,
    imapHost: 'imap.cap.test', imapPort: 993, imapUsername: 'u', imapPassword: 'pw' })],
  ['sent mirror', 'sent_mirror_connections', (co: string, n: string) => createSentImapConnection({ companyId: co, displayName: n, accountEmail: `${n}@s07eb.test`,
    imapHost: 'imap.cap.test', imapPort: 993, imapUsername: 'u', imapPassword: 'pw' })],
] as const;

describe.each(CREATORS)('S-07e part B (946) round 8: %s, the per-company cap on active connections', (_name, table, create) => {
  afterEach(async () => { await dropExtraCompanies(); });
  const activeCount = async (co: string) => Number((await q(`SELECT COUNT(*) AS n FROM ${table} WHERE company_id = $1 AND status = 'active'`, [co])).rows[0].n);

  it(`the ${MAX_ACTIVE_CONNECTIONS_PER_COMPANY + 1}th active connection is refused and not written; another company is unaffected; a disconnected one frees a slot`, async () => {
    const co = await newCompany();
    const mine: string[] = [];
    for (let i = 0; i < MAX_ACTIVE_CONNECTIONS_PER_COMPANY; i++) mine.push((await create(co, `cap-${i}`)).id);
    await expect(create(co, 'cap-over')).rejects.toBeInstanceOf(MirrorConnectionCapError);
    expect(await activeCount(co)).toBe(MAX_ACTIVE_CONNECTIONS_PER_COMPANY);
    expect((await create(await newCompany(), 'elsewhere')).id).toBeTruthy();
    await q(`UPDATE ${table} SET status = 'disconnected' WHERE id = $1`, [mine[0]]);
    expect((await create(co, 'cap-again')).id).toBeTruthy();
    expect(await activeCount(co)).toBe(MAX_ACTIVE_CONNECTIONS_PER_COMPANY);
  }, 60000);

  it('concurrent creates cannot overshoot the cap: of 12 at once exactly the limit succeed', async () => {
    const co = await newCompany();
    const settled = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => create(co, `race-${i}`)));
    const ok = settled.filter((r) => r.status === 'fulfilled').length;
    const refused = settled.filter((r) => r.status === 'rejected' && r.reason instanceof MirrorConnectionCapError).length;
    expect(await activeCount(co)).toBe(MAX_ACTIVE_CONNECTIONS_PER_COMPANY);
    expect([ok, refused]).toEqual([MAX_ACTIVE_CONNECTIONS_PER_COMPANY, 12 - MAX_ACTIVE_CONNECTIONS_PER_COMPANY]);
  }, 60000);

  it('a second create waits for the first one\'s lock (the check and the insert are one unit per company), then sees its row and is refused', async () => {
    const co = await newCompany();
    for (let i = 0; i < MAX_ACTIVE_CONNECTIONS_PER_COMPANY - 1; i++) await create(co, `held-${i}`);
    const kind = table === 'imap_mirror_connections' ? 'imap' : 'sent';
    const a: PoolClient = await fixture.connect();
    const b: PoolClient = await fixture.connect();
    try {
      await a.query('BEGIN');
      await assertUnderConnectionCap(a, kind, co); // room for one more
      await b.query('BEGIN');
      let settled = false;
      const second = assertUnderConnectionCap(b, kind, co).finally(() => { settled = true; });
      second.catch(() => undefined);
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // blocked on the company's lock, not yet counting
      await a.query(`INSERT INTO ${table} (company_id, provider, display_name, account_email, status, imap_host, imap_port, imap_use_tls, imap_username, imap_password_enc)
        VALUES ($1, 'imap', 'Last', $2, 'active', 'imap.cap.test', 993, true, 'u', 'enc:x')`, [co, `last-${crypto.randomUUID().slice(0, 6)}@s07eb.test`]);
      await a.query('COMMIT');
      await expect(second).rejects.toBeInstanceOf(MirrorConnectionCapError);
    } finally {
      await a.query('ROLLBACK').catch(() => undefined);
      await b.query('ROLLBACK').catch(() => undefined);
      a.release();
      b.release();
    }
  }, 30000);
});
