// tests/integration/s07b-change-email.int.test.ts
//
// S-07b follow-up B: change-email writes public.users FIRST, in a transaction
// on the migration_admin pool, then calls GoTrue, and commits only when GoTrue
// succeeded. Before, it called GoTrue first and mirrored the address on the
// service pool afterwards, logging and answering 200 when that UPDATE failed or
// matched no row, so the login email and the profile email drifted apart.
//
// Real route, real PG on the production logins; only GoTrue is stubbed. The
// stub records, at the moment GoTrue is asked to change the address, whether
// the caller's users row is already locked by an uncommitted write: that is
// what tells DB-first from GoTrue-first, since a GoTrue refusal leaves the
// stored email unchanged either way.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { decodeJwt } from 'jose';
import changeEmailRoute from '../../pages/api/auth/change-email';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { log } from '@/lib/logger';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { callRoute, userRow } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const ids = newIds();
const created: string[] = [];

beforeAll(() => setup(ids), 60000);
afterAll(async () => {
  await fixture.query('DELETE FROM users WHERE id = ANY($1)', [created]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
});
// Every suite's route calls share one client IP; the route allows 5 per 15 minutes.
beforeEach(() => fixture.query(`DELETE FROM rate_limit_counters WHERE key LIKE '%change-email%'`));
afterEach(() => { vi.unstubAllGlobals(); });

async function newUser(withRow = true): Promise<string> {
  const id = crypto.randomUUID();
  created.push(id);
  if (withRow) {
    await fixture.query(`INSERT INTO users (id, email, first_name, last_name, is_active, status)
      VALUES ($1, $2, 'Ce', 'Ce', true, 'active')`, [id, `${id}@test.local`]);
  }
  return id;
}

interface Gotrue { updates: string[]; rowLockedAtUpdate: boolean | null; bodies: unknown[] }

/** GoTrue: /token and /user answer for the caller; PUT /admin/users answers `adminStatus`. */
function stubGotrue(adminStatus: number): Gotrue {
  const seen: Gotrue = { updates: [], rowLockedAtUpdate: null, bodies: [] };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  vi.stubGlobal('fetch', vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/token')) return json(200, { access_token: 'x', token_type: 'bearer' });
    if (url.pathname.endsWith('/user')) {
      const bearer = new Headers(init?.headers).get('authorization')?.replace(/^Bearer /, '') ?? '';
      return json(200, { id: decodeJwt(bearer).sub, factors: [] });
    }
    const m = /\/admin\/users\/([0-9a-f-]+)$/.exec(url.pathname);
    if (m && init?.method === 'PUT') {
      seen.updates.push(m[1]!);
      seen.bodies.push(JSON.parse(String(init.body)));
      const c = await fixture.connect();
      try {
        await c.query('BEGIN');
        await c.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE NOWAIT`, [m[1]]);
        seen.rowLockedAtUpdate = false;
      } catch (err) {
        seen.rowLockedAtUpdate = (err as { code?: string }).code === '55P03' ? true : null;
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      if (adminStatus === 200) return json(200, { id: m[1], email: JSON.parse(String(init.body)).email });
      return json(adminStatus, { msg: adminStatus === 422 ? 'A user with this email address has already been registered' : 'boom' });
    }
    throw new Error(`unexpected fetch ${url}`);
  }));
  return seen;
}

const change = (sub: string, newEmail: string) =>
  callRoute(changeEmailRoute, { sub, method: 'POST', body: { newEmail, currentPassword: 'pw' } });

describe('change-email: the database first, then GoTrue', () => {
  it('GoTrue accepts: 200, users.email changed, and the row was already written when GoTrue was asked', async () => {
    const u = await newUser();
    const gt = stubGotrue(200);
    // Mixed case in: both stores get the same lower-cased address.
    const r = await change(u, `${u}-NEW@Test.Local`);
    expect(r.status).toBe(200);
    expect(gt).toMatchObject({ updates: [u], rowLockedAtUpdate: true });
    // email_confirm: the admin update skips GoTrue's double confirmation (see the route's header).
    expect(gt.bodies).toEqual([{ email: `${u}-new@test.local`, email_confirm: true }]);
    expect((await userRow(u)).email).toBe(`${u}-new@test.local`);
  });

  it('GoTrue refuses the address (422): 409, users.email unchanged', async () => {
    const u = await newUser();
    const gt = stubGotrue(422);
    const r = await change(u, `${u}-new@test.local`);
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'EMAIL_TAKEN' } } });
    expect(gt).toMatchObject({ updates: [u], rowLockedAtUpdate: true });
    expect((await userRow(u)).email).toBe(`${u}@test.local`);
  });

  it.each([
    ['refuses otherwise (400): 502', 400, 502, 'GOTRUE_ERROR'],
    ['is down (503): 503 auth-unavailable', 503, 503, 'AUTH_UNAVAILABLE'],
  ])('GoTrue %s, users.email unchanged', async (_, gotrueStatus, status, code) => {
    const u = await newUser();
    const gt = stubGotrue(gotrueStatus);
    const r = await change(u, `${u}-new@test.local`);
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ status, body: { error: { code } } });
    expect(gt).toMatchObject({ updates: [u], rowLockedAtUpdate: true });
    expect((await userRow(u)).email).toBe(`${u}@test.local`);
  });

  it('no users row: 404, and GoTrue is never asked to change the address', async () => {
    const u = await newUser(false);
    const gt = stubGotrue(200);
    const r = await change(u, `${u}-new@test.local`);
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ status: 404, body: { error: { code: 'USER_NOT_FOUND' } } });
    expect(gt.updates).toEqual([]);
  });

  it('an address another profile holds: 409 from the unique key, and GoTrue is never asked', async () => {
    const [u, holder] = [await newUser(), await newUser()];
    const gt = stubGotrue(200);
    const r = await change(u, `${holder}@test.local`);
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ status: 409, body: { error: { code: 'EMAIL_TAKEN' } } });
    expect(gt.updates).toEqual([]);
    expect((await userRow(u)).email).toBe(`${u}@test.local`);
  });

  it('GoTrue accepts but the COMMIT fails: 500, the drift is logged, users.email unchanged', async () => {
    const u = await newUser();
    // A deferred constraint trigger raises at COMMIT, after GoTrue has answered.
    await fixture.query('DROP TRIGGER IF EXISTS s07b_ce_commit_fail ON public.users');
    await fixture.query('DROP FUNCTION IF EXISTS public.s07b_ce_commit_fail()');
    await fixture.query(`CREATE FUNCTION public.s07b_ce_commit_fail() RETURNS trigger LANGUAGE plpgsql AS $f$
      BEGIN IF NEW.email LIKE '%-commitfail@test.local' THEN RAISE EXCEPTION 's07b: commit refused'; END IF; RETURN NULL; END $f$`);
    await fixture.query(`CREATE CONSTRAINT TRIGGER s07b_ce_commit_fail AFTER UPDATE ON public.users DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION public.s07b_ce_commit_fail()`);
    const error = vi.spyOn(log, 'error');
    try {
      const gt = stubGotrue(200);
      const r = await change(u, `${u}-commitfail@test.local`);
      vi.unstubAllGlobals();
      expect(r.status).toBe(500);
      expect(gt.updates).toEqual([u]);
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/drift/), expect.objectContaining({ userId: u }), 'Auth');
      expect((await userRow(u)).email).toBe(`${u}@test.local`);
    } finally {
      error.mockRestore();
      await fixture.query('DROP TRIGGER s07b_ce_commit_fail ON public.users');
      await fixture.query('DROP FUNCTION public.s07b_ce_commit_fail()');
    }
  });
});
