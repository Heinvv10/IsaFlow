/**
 * Budgets P5 T8 (spec §4, §6 T8): the user_notifications service on real PostgreSQL. A member's
 * feed and unread count are their own rows of the active company only (two users, two companies),
 * marking read touches only their own rows, and a notification is written once per dedupe key.
 * The list and the count are scoped by `user_id` in the query itself, not by RLS alone: the
 * service pool (app_service) has USING (true) mirrors, so the query is checked there too.
 *
 * Fixture route: isaflow_schema_fixture (assertDisposable). Never skips.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { als } from '@/lib/als';
import { listNotifications, markRead, notifyUsers } from '@/modules/accounting/services/notifications/userNotificationService';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const A = crypto.randomUUID();
const B = crypto.randomUUID();
const owner = crypto.randomUUID();
const manager = crypto.randomUUID();
const bUser = crypto.randomUUID();

beforeAll(async () => {
  await pool.query('INSERT INTO companies (id, name) VALUES ($1, $2), ($3, $4)', [A, 'P5N A', B, 'P5N B']);
  for (const u of [owner, manager, bUser]) {
    await pool.query("INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'admin', true)", [u, `${u}@test.local`]);
  }
  await pool.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'owner'), ($1, $3, 'manager'),
                    ($4, $2, 'owner'), ($4, $5, 'owner')`, [A, owner, manager, B, bUser]);
  // The owner: 22 rows in A (oldest first, two read), one in B. The manager: 3 in A. B's own user: 1 in B.
  for (let i = 0; i < 22; i += 1) {
    await pool.query(`INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key, created_at, read_at)
                      VALUES ($1, $2, 'budget_alert', $3, $4, now() - make_interval(mins => $5), $6)`,
    [A, owner, `Owner ${String(i).padStart(2, '0')}`, `o-${i}`, 100 - i, i < 2 ? new Date() : null]);
  }
  await pool.query(`INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key)
                    VALUES ($1, $2, 'budget_alert', 'Owner in B SECRET', 'ob'), ($1, $3, 'budget_alert', 'B user SECRET', 'b1')`, [B, owner, bUser]);
  for (let i = 0; i < 3; i += 1) {
    await pool.query(`INSERT INTO user_notifications (company_id, user_id, kind, title, dedupe_key) VALUES ($1, $2, 'budget_slice', $3, $4)`,
      [A, manager, `Manager SECRET ${i}`, `m-${i}`]);
  }
}, 60_000);
afterAll(async () => {
  try {
    await pool.query('DELETE FROM user_notifications WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM company_users WHERE company_id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM companies WHERE id = ANY($1)', [[A, B]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::TEXT[])', [[owner, manager, bUser]]);
  } finally { await pool.end(); }
});

/** One rolled-back request as `role` (withAuth's app_user, or the service pool's app_service), claims for `user` in `co`. */
async function as<T>(role: 'app_user' | 'app_service', co: string, user: string, fn: () => Promise<T>): Promise<T> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: user })]);
    await client.query("SELECT set_config('app.current_company_id', $1, true)", [co]);
    return await als.run({ client, companyId: co, userId: user, claims: { sub: user } }, fn);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

describe('listNotifications', () => {
  it.each(['app_user', 'app_service'] as const)('as %s: the latest 20 of the member\'s own rows in the active company, and their unread count', async (role) => {
    const out = await as(role, A, owner, () => listNotifications(A, owner));
    expect(out.items).toHaveLength(20);
    // Newest first: 'Owner 21' was written 79 minutes ago, 'Owner 00' 100.
    expect(out.items[0]!.title).toBe('Owner 21');
    expect(out.items.every((n) => n.title.startsWith('Owner ') && !n.title.includes('SECRET'))).toBe(true);
    expect(out.unread).toBe(20);
    expect(typeof out.items[0]!.createdAt).toBe('string');
    expect(out.items[0]!.readAt).toBeNull();
  });

  it.each(['app_user', 'app_service'] as const)('as %s: another member of the same company sees only theirs', async (role) => {
    const out = await as(role, A, manager, () => listNotifications(A, manager));
    expect(out.items.map((n) => n.title).sort()).toEqual(['Manager SECRET 0', 'Manager SECRET 1', 'Manager SECRET 2']);
    expect(out.unread).toBe(3);
  });

  it('the same user in another company sees that company\'s rows only', async () => {
    const out = await as('app_user', B, owner, () => listNotifications(B, owner));
    expect(out.items.map((n) => n.title)).toEqual(['Owner in B SECRET']);
  });
});

describe('markRead', () => {
  it.each(['app_user', 'app_service'] as const)('as %s: marks only the caller\'s own rows, by id or all', async (role) => {
    await as(role, A, owner, async () => {
      const mine = (await listNotifications(A, owner)).items.slice(0, 2).map((n) => n.id);
      const theirs = String((await pool.query(`SELECT id FROM user_notifications WHERE company_id = $1 AND user_id = $2 LIMIT 1`, [A, manager])).rows[0].id);
      expect(await markRead(A, owner, { ids: [...mine, theirs] })).toEqual({ updated: 2 });
      expect((await listNotifications(A, owner)).unread).toBe(18);
      expect(await markRead(A, owner, { all: true })).toEqual({ updated: 18 });
      expect((await listNotifications(A, owner)).unread).toBe(0);
    });
    // Read outside the request (as the owner role): the manager's rows were never touched.
    expect((await pool.query(`SELECT COUNT(*)::int n FROM user_notifications WHERE company_id = $1 AND user_id = $2 AND read_at IS NULL`,
      [A, manager])).rows[0].n).toBe(3);
  });
});

describe('notifyUsers', () => {
  it('writes one row per user per dedupe key; a rerun writes nothing; written for others, invisible to the writer', async () => {
    const n = { kind: 'budget_slice' as const, refId: null, title: 'Slice submitted', body: 'Ops', href: '/accounting/budgets', dedupeKey: 'slice:x' };
    try {
      for (let run = 0; run < 2; run += 1) {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query('SET LOCAL ROLE app_user');
          await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: manager })]);
          await client.query("SELECT set_config('app.current_company_id', $1, true)", [A]);
          await als.run({ client, companyId: A, userId: manager, claims: { sub: manager } }, async () => {
            await notifyUsers(A, [owner, owner, manager], n);
            expect((await listNotifications(A, manager)).items.filter((x) => x.title === 'Slice submitted')).toHaveLength(1);
          });
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK');
          throw err;
        } finally { client.release(); }
      }
      const r = await pool.query(`SELECT user_id FROM user_notifications WHERE company_id = $1 AND dedupe_key = 'slice:x' ORDER BY user_id`, [A]);
      expect(r.rows.map((x) => x.user_id)).toEqual([owner, manager].sort());
      const o = await as('app_user', A, owner, () => listNotifications(A, owner));
      expect(o.items[0]).toMatchObject({ title: 'Slice submitted', kind: 'budget_slice', href: '/accounting/budgets', readAt: null });
    } finally {
      await pool.query(`DELETE FROM user_notifications WHERE company_id = $1 AND dedupe_key = 'slice:x'`, [A]);
    }
  });

  it('skips a recipient who is no longer a member (another company\'s user, an unknown id), writes the rest, and says whom it skipped', async () => {
    const n = { kind: 'budget_slice' as const, refId: null, title: 'x', body: null, href: null, dedupeKey: 'nm' };
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE app_user');
      await client.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: manager })]);
      await client.query("SELECT set_config('app.current_company_id', $1, true)", [A]);
      await als.run({ client, companyId: A, userId: manager, claims: { sub: manager } }, async () => {
        expect(await notifyUsers(A, [owner, bUser, 'no-such-user'], n)).toEqual({ skipped: [bUser, 'no-such-user'] });
        expect(await notifyUsers(A, ['no-such-user'], n)).toEqual({ skipped: ['no-such-user'] });
        // The request goes on: no 23503 poisoned it.
        expect((await listNotifications(A, manager)).unread).toBe(3);
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally { client.release(); }
    try {
      const r = await pool.query(`SELECT user_id FROM user_notifications WHERE dedupe_key = 'nm'`);
      expect(r.rows.map((x) => x.user_id)).toEqual([owner]);
    } finally {
      await pool.query(`DELETE FROM user_notifications WHERE dedupe_key = 'nm'`);
    }
  });

  it('fits title and body to the table (200 / 2 000 characters, NUL dropped) instead of failing the caller\'s transaction', async () => {
    try {
      await as('app_service', A, owner, async () => {
        await notifyUsers(A, [owner], { kind: 'budget_alert', refId: null, title: `  ${'T'.repeat(250)}\u0000`, body: `${'é'.repeat(2500)}`, href: null, dedupeKey: 'long' });
        const row = (await listNotifications(A, owner)).items.find((x) => x.title.startsWith('T'))!;
        expect([...row.title]).toHaveLength(200);
        expect([...row.body!]).toHaveLength(2000);
        expect(row.title.includes('\u0000')).toBe(false);
      });
      await as('app_user', A, owner, async () => {
        await expect(notifyUsers(A, [owner], { kind: 'budget_alert', refId: null, title: '   ', body: null, href: null, dedupeKey: 'blank' }))
          .rejects.toThrow(/title/);
        await expect(notifyUsers(A, [owner], { kind: 'budget_alert', refId: null, title: 't', body: null, href: null, dedupeKey: 'k'.repeat(201) }))
          .rejects.toThrow(/dedupeKey/);
      });
    } finally {
      await pool.query(`DELETE FROM user_notifications WHERE dedupe_key = 'long'`);
    }
  });

  it('the service pool\'s login (isaflow_service, no claims: the cron) writes for a member', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE isaflow_service');
      await als.run({ client, companyId: A, userId: '', claims: {} }, () => notifyUsers(A, [owner],
        { kind: 'budget_alert', refId: null, title: 'From the cron', body: null, href: '/accounting/budgets', dedupeKey: 'cron' }));
      expect((await client.query(`SELECT COUNT(*)::int n FROM user_notifications WHERE dedupe_key = 'cron' AND user_id = $1`, [owner])).rows[0].n).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('refuses a link that is not an in-app path before writing', async () => {
    await as('app_user', A, owner, async () => {
      await expect(notifyUsers(A, [owner], { kind: 'budget_alert', refId: null, title: 't', body: null, href: 'https://evil.example', dedupeKey: 'x' }))
        .rejects.toThrow(/in-app path/);
    });
  });
});
