// tests/integration/s07e-b-routes-paths-scan.int.test.ts
//
// S-07e part B (migration 946): scan-now's request transaction holds the
// connection row from the scan's cursor stamp on. If the scan then fails, the
// status flip to 'error' (migration_admin, not an app-pool column) would wait
// on that row lock until its 5s lock_timeout, then give up. mirrorScanError.ts
// therefore stamps the error in the request and defers the flip until the
// request has committed. Proven through the real scan-now route on the
// production logins; the IMAP client is stubbed so the scan fails AFTER the
// cursor stamp (the mailbox lock's release throws; the finally block that
// runs it sits after updateCursor).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import scanNowRoute from '../../pages/api/accounting/capture/mirror/[id]/scan-now';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool, billingAdminPool } from '@/lib/auth/migrationAdminPool';
import { createImapConnection } from '@/modules/accounting/services/capture/mirrorConnectionService';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const imap = vi.hoisted(() => ({ releaseError: 'mailbox lock release failed after the cursor stamp' }));
vi.mock('node:dns/promises', () => ({ lookup: async () => [{ address: '93.184.216.34', family: 4 }] }));
vi.mock('imapflow', () => ({
  ImapFlow: class {
    async connect() { return undefined; }
    async getMailboxLock() { return { release: () => { throw new Error(imap.releaseError); } }; }
    async *fetch() { yield { uid: 9, envelope: { subject: 'newsletter', from: [{ address: 'a@x.test' }] } }; }
    async fetchOne() { return false; }
    async logout() { return undefined; }
  },
}));

const ids = newIds();
const { owner, company } = ids;
const q = (text: string, params: unknown[] = []) => fixture.query(text, params);
const row = async (id: string) => (await q('SELECT * FROM imap_mirror_connections WHERE id = $1', [id])).rows[0] as Record<string, unknown>;
// Well under migration_admin's 5s lock_timeout: a flip that waited on the row would not return in this time.
const PROMPT_MS = 2500;

beforeAll(async () => {
  await setup(ids);
  vi.stubEnv('ENCRYPTION_KEY', 'disposable-s07e-b-encryption-key-over-32-characters');
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner')
    ON CONFLICT (company_id, user_id) DO UPDATE SET role = 'owner'`, [company, owner]);
}, 60000);

afterAll(async () => {
  await q('DELETE FROM imap_mirror_connections WHERE company_id = $1', [company]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool(), billingAdminPool()]);
});

describe('S-07e part B (946): scan-now fails after its cursor stamp', () => {
  it('answers promptly, then migration_admin flips the status to error once the request has committed', async () => {
    const { id } = await createImapConnection({ companyId: company, displayName: 'Lock', accountEmail: 'lock@s07eb.test',
      imapHost: 'imap.s07eb.test', imapPort: 993, imapUsername: 'ap', imapPassword: 'mailbox-pw' });
    expect(await row(id)).toMatchObject({ status: 'active', scan_cursor: {} });

    const started = Date.now();
    const res = await callRoute(scanNowRoute, { sub: owner, method: 'POST', companyId: company, query: { id } });
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect((res.body as { data: Record<string, number> }).data).toMatchObject({ scanned: 1, errors: 1 });
    expect(elapsed, `scan-now took ${elapsed}ms`).toBeLessThan(PROMPT_MS);
    // The cursor stamp (the row lock's source) committed with the request, so the failure came after it.
    expect((await row(id)).scan_cursor).toEqual({ INBOX: 9 });
    await vi.waitFor(async () => expect(await row(id)).toMatchObject({ status: 'error', last_error: imap.releaseError }), { timeout: 10000 });
  });
});
