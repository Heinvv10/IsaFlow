/**
 * Admin announcements API (audit follow-up to 4.8): the window an announcement runs in.
 *  - PATCH can clear ends_at (null = no end); an omitted ends_at still means "keep".
 *  - The server refuses ends_at <= starts_at with a 400, on create and on update (the stored value stands in for
 *    whichever side the body leaves out), and refuses a date it cannot read; nothing is written when it refuses.
 * Through the real routes (withAdmin, CSRF, the audit write) on the disposable schema fixture.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import createRoute from '../../pages/api/admin/announcements';
import oneRoute from '../../pages/api/admin/announcements/[id]';
import { updateAnnouncement } from '@/modules/admin/services/announcementService';
import { announcementWindowError } from '@/modules/admin/services/announcementWindow';
import { assertDisposable, request, response } from './mfa-impersonation-postgres.helpers';
import { signSession } from './r-032-fake-gotrue.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
const admin = crypto.randomUUID();
const TAG = `AWIN-${Date.now()}`;

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
  call(createRoute as Route, 'POST', { title: `${TAG} t`, message: 'm', ...b });
const patch = (id: string, b: Record<string, unknown>) => call(oneRoute as Route, 'PATCH', b, id);
const stored = async (id: string) =>
  (await pool.query(`SELECT starts_at, ends_at FROM system_announcements WHERE id = $1`, [id])).rows[0] as
    { starts_at: Date; ends_at: Date | null } | undefined;
const count = async () =>
  (await pool.query(`SELECT count(*)::int AS n FROM system_announcements WHERE created_by = $1`, [admin])).rows[0].n as number;

const S = '2026-12-01T08:00:00.000Z';
const E = '2026-12-05T08:00:00.000Z';
let id: string;

beforeAll(async () => {
  await pool.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'super_admin', true)`, [admin, `${admin}@test.local`]);
  const r = await create({ starts_at: S, ends_at: E });
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  id = r.body.data!.id!;
}, 60000);

afterAll(async () => {
  try {
    await pool.query('DELETE FROM system_announcements WHERE created_by = $1', [admin]);
    await pool.query('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
    await pool.query('DELETE FROM users WHERE id = $1', [admin]);
    await pool.query("DELETE FROM rate_limit_counters WHERE key = 'admin:127.0.0.79'");
  } finally {
    await pool.end();
  }
}, 60000);

describe('create: the window', () => {
  it.each([
    ['ends before it starts', { starts_at: S, ends_at: '2026-11-30T08:00:00.000Z' }],
    ['ends the instant it starts', { starts_at: S, ends_at: S }],
    ['starts at a date nobody can read', { starts_at: 'soon' }],
    ['ends at a date nobody can read', { starts_at: S, ends_at: 'later' }],
  ])('refuses one that %s (400) and writes nothing', async (_name, body) => {
    const before = await count();
    const r = await create(body);
    expect(r.status).toBe(400);
    expect(r.body.error?.message).toMatch(/end|start|date/i);
    expect(await count()).toBe(before);
  });

  it('accepts an open-ended one and one that ends after it starts', async () => {
    expect((await create({ starts_at: S })).status).toBe(200);
    expect((await create({ starts_at: S, ends_at: E })).status).toBe(200);
  });
});

describe('update: clearing and checking ends_at', () => {
  it('ends_at: null clears the end; the start stands', async () => {
    const r = await patch(id, { ends_at: null });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const row = (await stored(id))!;
    expect(row.ends_at).toBeNull();
    expect(row.starts_at.toISOString()).toBe(S);
  });

  it('a body that leaves ends_at out keeps whatever is stored', async () => {
    expect((await patch(id, { ends_at: E })).status).toBe(200);
    expect((await patch(id, { title: `${TAG} renamed` })).status).toBe(200);
    expect((await stored(id))!.ends_at?.toISOString()).toBe(E);
  });

  it('refuses an end at or before the stored start, and writes nothing', async () => {
    for (const ends_at of [S, '2026-11-30T08:00:00.000Z']) {
      const r = await patch(id, { ends_at });
      expect(r.status).toBe(400);
      expect(r.body.error?.message).toMatch(/end/i);
    }
    expect((await stored(id))!.ends_at?.toISOString()).toBe(E);
  });

  it('refuses a new start at or after the stored end', async () => {
    const r = await patch(id, { starts_at: '2026-12-06T08:00:00.000Z' });
    expect(r.status).toBe(400);
    expect((await stored(id))!.starts_at.toISOString()).toBe(S);
  });

  it('moving both together is judged on the new pair', async () => {
    expect((await patch(id, { starts_at: '2026-12-10T08:00:00.000Z', ends_at: '2026-12-12T08:00:00.000Z' })).status).toBe(200);
    expect((await patch(id, { starts_at: S, ends_at: E })).status).toBe(200);
  });

  it('a start moved later while the end is cleared in the same body is fine', async () => {
    expect((await patch(id, { starts_at: '2027-01-01T08:00:00.000Z', ends_at: null })).status).toBe(200);
    expect((await stored(id))!.ends_at).toBeNull();
    expect((await patch(id, { starts_at: S, ends_at: E })).status).toBe(200);
  });

  it('refuses an unreadable date, and answers 404 for an announcement that does not exist', async () => {
    expect((await patch(id, { ends_at: 'later' })).status).toBe(400);
    expect((await patch(crypto.randomUUID(), { title: 'x' })).status).toBe(404);
  });

  it('the audit row of a clear says ends_at was cleared', async () => {
    await patch(id, { ends_at: null });
    const r = await pool.query(
      `SELECT details FROM admin_audit_log WHERE admin_user_id = $1 AND action = 'announcement.update' AND target_id = $2
        ORDER BY created_at DESC LIMIT 1`, [admin, id]);
    expect(r.rows[0].details).toMatchObject({ ends_at: null });
  });
});

describe('update: the window is guarded by the UPDATE itself', () => {
  const fresh = async () => {
    const r = await create({ starts_at: S });
    return r.body.data!.id!;
  };

  it('a stale pre-read cannot store a bad pair: the end was set after the check read the row', async () => {
    const aid = await fresh(); // stored: starts S, no end
    const later = '2026-12-09T08:00:00.000Z';
    // The pre-check reads the row (no end) and passes a start moved to `later` ...
    expect(announcementWindowError(later, null)).toBeNull();
    // ... then another admin sets an end before `later` ...
    await pool.query(`UPDATE system_announcements SET ends_at = $2 WHERE id = $1`, [aid, E]);
    // ... and the write must still refuse.
    expect(await updateAnnouncement(aid, { starts_at: later })).toBe('window');
    const row = (await stored(aid))!;
    expect(row.starts_at.toISOString()).toBe(S);
    expect(row.ends_at?.toISOString()).toBe(E);
  });

  it('answers by outcome: updated, window (row exists, pair bad, nothing written), not_found', async () => {
    const aid = await fresh();
    expect(await updateAnnouncement(aid, { ends_at: E })).toBe('updated');
    expect(await updateAnnouncement(aid, { ends_at: S })).toBe('window');
    expect(await updateAnnouncement(aid, { ends_at: null })).toBe('updated');
    expect((await stored(aid))!.ends_at).toBeNull();
    expect(await updateAnnouncement(crypto.randomUUID(), { title: 'x' })).toBe('not_found');
  });

  it('a title-only update on a row whose window is already bad (made before this check) goes through; touching the window must fix it', async () => {
    const aid = await fresh();
    await pool.query(`UPDATE system_announcements SET ends_at = starts_at WHERE id = $1`, [aid]); // an old, bad row
    expect(await updateAnnouncement(aid, { title: `${TAG} fixed` })).toBe('updated');
    expect(await updateAnnouncement(aid, { starts_at: S })).toBe('window');
    expect(await updateAnnouncement(aid, { ends_at: E })).toBe('updated');
  });
});

describe('a malformed id', () => {
  it.each(['PATCH', 'DELETE', 'GET'])('%s answers 404, not a database cast error', async (method) => {
    const r = await call(oneRoute as Route, method, method === 'PATCH' ? { title: 'x' } : undefined, 'not-a-uuid');
    expect(r.status).toBe(404);
  });
});
