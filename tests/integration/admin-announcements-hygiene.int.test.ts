/**
 * Admin announcements API: size limits on what a tenant will read, and what deleting an announcement leaves behind.
 *  - title <= 200 (the column is varchar(200)) and message <= 2000 characters, refused with a 400 that says which,
 *    on create and on update, before anything is written (the banner shows both to every targeted user).
 *  - Deleting an announcement also deletes every user's dismissal of it (user_preferences announcement_dismissed:<id>),
 *    and nothing else of theirs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import createRoute from '../../pages/api/admin/announcements';
import oneRoute from '../../pages/api/admin/announcements/[id]';
import { DISMISS_KEY_PREFIX } from '@/lib/tenantAnnouncements';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const admin = crypto.randomUUID();
const member = crypto.randomUUID();
const TAG = `AHYG-${Date.now()}`;

type Route = (req: never, res: never) => Promise<unknown>;
async function call(route: Route, method: string, body: unknown, id?: string) {
  const jar = { 'sb-access-token': await signSession(admin, crypto.randomUUID(), 'aal2') };
  const req = request(jar, method, id) as unknown as { body: unknown; url: string };
  req.body = body;
  req.url = `/api/admin/announcements${id ? `/${id}` : ''}`;
  const out = response();
  await route(req as never, out.res as never);
  return { status: out.state.statusCode, body: out.state.body as { data?: { id?: string }; error?: { message?: string } } };
}
const create = (b: Record<string, unknown>) =>
  call(createRoute as Route, 'POST', { title: `${TAG} t`, message: 'm', starts_at: '2026-12-01T08:00:00.000Z', ...b });
const patch = (id: string, b: Record<string, unknown>) => call(oneRoute as Route, 'PATCH', b, id);
const remove = (id: string) => call(oneRoute as Route, 'DELETE', undefined, id);
const count = async () =>
  (await pool.query(`SELECT count(*)::int AS n FROM system_announcements WHERE created_by = $1`, [admin])).rows[0].n as number;
const prefs = async () =>
  (await pool.query(`SELECT key FROM user_preferences WHERE user_id = $1 ORDER BY key`, [member])).rows.map(r => r.key as string);

beforeAll(async () => {
  for (const [id, role] of [[admin, 'super_admin'], [member, 'viewer']] as const) {
    await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, $3, true)`, [id, `${id}@test.local`, role]);
  }
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM user_preferences WHERE user_id = $1', [member]);
    await pool.query('DELETE FROM system_announcements WHERE created_by = $1', [admin]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::text[])', [[admin, member]]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('title and message are bounded', () => {
  it.each([
    ['a 201-character title', { title: 'x'.repeat(201) }, /title/i],
    ['a 2001-character message', { message: 'x'.repeat(2001) }, /message/i],
  ])('create refuses %s with a 400 that names the field, and writes nothing', async (_n, body, field) => {
    const before = await count();
    const r = await create(body);
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(field);
    expect(await count()).toBe(before);
  });

  it('accepts the limits exactly (200 / 2000)', async () => {
    const r = await create({ title: 'x'.repeat(200), message: 'y'.repeat(2000) });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
  });

  it('update refuses the same, and the stored text stands', async () => {
    const id = (await create({})).body.data!.id!;
    for (const [body, field] of [[{ title: 'x'.repeat(201) }, /title/i], [{ message: 'x'.repeat(2001) }, /message/i]] as const) {
      const r = await patch(id, body);
      expect(r.status).toBe(400);
      expect(r.body.error?.message).toMatch(field);
    }
    const row = (await pool.query('SELECT title, message FROM system_announcements WHERE id = $1', [id])).rows[0];
    expect(row).toEqual({ title: `${TAG} t`, message: 'm' });
  });
});

describe('deleting an announcement', () => {
  it('removes every user\'s dismissal of it, and only those', async () => {
    const id = (await create({})).body.data!.id!;
    const other = (await create({})).body.data!.id!;
    for (const key of [DISMISS_KEY_PREFIX + id, DISMISS_KEY_PREFIX + other, 'theme']) {
      await pool.query(`INSERT INTO user_preferences (user_id, key, value) VALUES ($1, $2, 'x')`, [member, key]);
    }
    const r = await remove(id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await prefs()).toEqual([DISMISS_KEY_PREFIX + other, 'theme'].sort());
    expect((await pool.query('SELECT 1 FROM system_announcements WHERE id = $1', [id])).rowCount).toBe(0);
  });
});
