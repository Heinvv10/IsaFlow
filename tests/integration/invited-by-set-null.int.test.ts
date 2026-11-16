/**
 * Deleting a user who sent invitations (migration 997c, Hein 2026-11-16).
 *
 * company_invitations.invited_by was NOT NULL with a NO ACTION FK to users(id), so DELETE
 * /api/admin/users/<id> on anyone who had ever sent an invitation was refused (23503), answered 500
 * and deleted nothing. 997c makes the column nullable and the FK ON DELETE SET NULL: the invitation
 * keeps everything except who sent it. Pinned here, on real Postgres, through the real routes:
 *   · the DELETE answers 200; a pending and an accepted invitation the user sent both remain, with
 *     invited_by NULL and every other column unchanged; its `user.delete` audit row lists their ids
 *     (sent_invitations_unattributed, [] for a user who sent none), so who sent them is not lost;
 *   · GET /api/invite/<token> names the sender 'Someone'; the members screen lists the invitation
 *     with invitedBy null; the invitee still accepts it (POST /api/invite/<token>);
 *   · on production's shape (table owned by migration_admin; 997c applied by `postgres`, no
 *     superuser, BYPASSRLS, a member of migration_admin), the SET NULL passes
 *     company_invitations_role_guard, which refuses platform_admin's own writes (RC008): Postgres
 *     runs it as the table's owner;
 *   · lock order: the legacy accept holds the invitation row FIRST (FOR UPDATE); a DELETE of its
 *     sender waits on that row at the SET NULL, holding company_users and users rows the accept
 *     never needs, so the accept commits and the DELETE then answers 200 (no 40P01);
 *   · 997c converts the old constraint, and a rerun changes nothing.
 * Admin requests run as platform_admin (options=-c role=...), the invite routes on the production
 * logins (s07b helpers). Disposable fixture only.
 */
import { readFileSync } from 'fs';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// No GoTrue in the fixture: deleteUser (its invitation cancel, 997b) and POST /api/invite/<token> read the login email
// through adminGetUser; answer the address this suite's sessions carry (signSession).
vi.mock('@/lib/auth/gotrueAdminUser', async () =>
  (await import('./helpers/fixtureGotrueLogin')).fixtureGotrueLogin((id) => `${id}@test.local`));
import type { PoolClient } from 'pg';
import userRoute from '../../pages/api/admin/users/[id]';
import inviteRoute from '../../pages/api/invite/[token]';
import invitationsRoute from '../../pages/api/accounting/company-invitations';
import { getAuthPool } from '@/lib/auth/authPool';
import { getDbPool } from '@/lib/neon';
import { migrationAdminPool } from '@/lib/auth/migrationAdminPool';
import { hashInviteToken } from '@/lib/auth/inviteToken';
import { callRoute } from './s07-users-privilege-columns.helpers';
import { fixture, newIds, setup, teardown } from './s07b-app-pool-login-role.helpers';

const asPlatformAdmin = new URL(process.env.DATABASE_URL!);
asPlatformAdmin.searchParams.set('options', '-c role=platform_admin');
process.env.PLATFORM_ADMIN_DATABASE_URL = asPlatformAdmin.toString();

const FK = 'company_invitations_invited_by_fkey';
const migration = () => readFileSync(path.join(__dirname, '../../scripts/migrations/sql/997c_company_invitations_invited_by_set_null.sql'), 'utf8');
const ids = newIds();
const { company, admin, owner } = ids;
const users: string[] = [];

type Row = Record<string, unknown>;
const q = async (text: string, params: unknown[] = []) => (await fixture.query(text, params)).rows as Row[];
const invitationsBy = (ids_: string[]) => q('SELECT * FROM company_invitations WHERE id = ANY($1::uuid[]) ORDER BY id', [ids_]);
const deleteUser = (id: string) => callRoute(userRoute, { sub: admin, method: 'DELETE', query: { id } });

/** A users row, an admin membership of `company`, and `invites` invitations it sent: [email, accepted]. */
const inviter = (invites: Array<[string, boolean]>) => inviterWithId(crypto.randomUUID(), invites);
async function inviterWithId(id: string, invites: Array<[string, boolean]>): Promise<{ id: string; invites: Array<{ id: string; token: string }> }> {
  users.push(id);
  await q(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [id, `${id}@test.local`]);
  await q(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')`, [company, id]);
  const out = [];
  for (const [email, accepted] of invites) {
    const token = `inviter-${crypto.randomUUID()}`;
    const r = await q(`INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at, accepted_at)
      VALUES ($1, $2, 'viewer', $3, $4, NOW() + interval '1 day', CASE WHEN $5 THEN NOW() END) RETURNING id`,
    [company, email, id, hashInviteToken(token), accepted]);
    out.push({ id: r[0]!.id as string, token });
  }
  return { id, invites: out };
}
/** A GoTrue identity with no users row; signSession's email claim is `${id}@test.local`. */
const identity = () => { const id = crypto.randomUUID(); users.push(id); return { id, email: `${id}@test.local` }; };

beforeAll(() => setup(ids), 60000);
beforeEach(() => q(`DELETE FROM rate_limit_counters WHERE key LIKE 'admin:%' OR key LIKE 'invite%'`));
afterAll(async () => {
  await q('DELETE FROM company_users WHERE user_id = ANY($1)', [users]);
  await q('DELETE FROM company_invitations WHERE company_id = $1', [company]);
  await q('DELETE FROM admin_audit_log WHERE admin_user_id = $1', [admin]);
  await q('DELETE FROM users WHERE id = ANY($1)', [users]);
  await teardown(ids, [getAuthPool(), getDbPool(), migrationAdminPool()]);
}, 60000);

describe('997c: deleting a user who sent invitations', () => {
  const invitee = identity();
  let sender: Awaited<ReturnType<typeof inviter>>;
  let before: Row[];

  beforeAll(async () => {
    sender = await inviter([[invitee.email, false], [`accepted-${crypto.randomUUID()}@test.local`, true]]);
    before = await invitationsBy(sender.invites.map((i) => i.id));
  });

  it('DELETE answers 200; both invitations remain with invited_by NULL and every other column unchanged', async () => {
    expect(before.map((r) => r.invited_by)).toEqual([sender.id, sender.id]);
    const r = await deleteUser(sender.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await q('SELECT 1 FROM users WHERE id = $1', [sender.id])).toEqual([]);
    expect(await invitationsBy(sender.invites.map((i) => i.id))).toEqual(before.map((row) => ({ ...row, invited_by: null })));
    // Attribution kept: the audit row lists every invitation the delete left with no sender.
    expect(await q(`SELECT details FROM admin_audit_log WHERE target_id = $1 AND action = 'user.delete'`, [sender.id]))
      .toEqual([{ details: { invitations_cancelled: 0, sent_invitations_unattributed: sender.invites.map((i) => i.id).sort() } }]);
  });

  it('a user who sent nothing: the audit row records an empty list', async () => {
    const quiet = await inviter([]);
    expect((await deleteUser(quiet.id)).status).toBe(200);
    expect(await q(`SELECT details FROM admin_audit_log WHERE target_id = $1 AND action = 'user.delete'`, [quiet.id]))
      .toEqual([{ details: { invitations_cancelled: 0, sent_invitations_unattributed: [] } }]);
  });

  it('an invitation the user sent to their own address: listed as sent, then cancelled as theirs (997b)', async () => {
    const id = crypto.randomUUID();
    const self = await inviterWithId(id, [[`${id}@test.local`, false]]);
    expect((await deleteUser(id)).status).toBe(200);
    expect(await invitationsBy([self.invites[0]!.id])).toEqual([]);
    expect(await q(`SELECT details FROM admin_audit_log WHERE target_id = $1 AND action = 'user.delete'`, [id]))
      .toEqual([{ details: { invitations_cancelled: 1, sent_invitations_unattributed: [self.invites[0]!.id] } }]);
  });

  it('GET /api/invite/<token> of the pending one names the sender "Someone"', async () => {
    const r = await callRoute(inviteRoute, { sub: invitee.id, method: 'GET', query: { token: sender.invites[0]!.token } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((r.body as { data: Row }).data).toMatchObject({ role: 'viewer', invitedBy: 'Someone' });
  });

  it('the members screen lists it with invitedBy null', async () => {
    const r = await callRoute(invitationsRoute, { sub: owner, method: 'GET', companyId: company });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const listed = (r.body as { data: Row[] }).data.find((i) => i.id === sender.invites[0]!.id);
    expect(listed).toMatchObject({ email: invitee.email, invitedBy: null });
  });

  it('its invitee still accepts it', async () => {
    const r = await callRoute(inviteRoute, { sub: invitee.id, method: 'POST', query: { token: sender.invites[0]!.token } });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(await q('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, invitee.id]))
      .toEqual([{ role: 'viewer' }]);
    const [row] = await invitationsBy([sender.invites[0]!.id]);
    expect(row).toMatchObject({ invited_by: null });
    expect(row!.accepted_at).not.toBeNull();
  });
});

describe('997c on production\'s shape: owner migration_admin, applied by a non-superuser member', () => {
  it('postgres (no superuser, BYPASSRLS, member of migration_admin) applies it over a live row; platform_admin\'s own UPDATE '
    + 'is then RC008, and its users DELETE nulls invited_by (the SET NULL runs as the owner)', async () => {
    const c = await fixture.connect();
    try {
      await c.query('BEGIN');
      await c.query('ALTER TABLE company_invitations OWNER TO migration_admin');
      await toMasterShape(c);
      const sender = await inviterOn(c);
      // Only so this session can take platform_admin below once it is no superuser (the app's own login does).
      await c.query('GRANT platform_admin TO postgres');
      await c.query('ALTER ROLE postgres NOSUPERUSER');
      expect((await c.query(`SELECT r.rolsuper, r.rolbypassrls, pg_has_role(r.oid, 'migration_admin', 'USAGE') AS member,
          (SELECT relowner::regrole::text FROM pg_class WHERE oid = 'company_invitations'::regclass) AS owner
        FROM pg_roles r WHERE r.rolname = current_user`)).rows)
        .toEqual([{ rolsuper: false, rolbypassrls: true, member: true, owner: 'migration_admin' }]);
      await c.query('SAVEPOINT su');
      expect(await c.query('SET LOCAL session_replication_role = replica').then(() => 'set', (e: { code?: string }) => e.code))
        .toBe('42501'); // the demotion holds in this session
      await c.query('ROLLBACK TO SAVEPOINT su');
      await c.query(migration());
      expect(await shape(c)).toEqual(SET_NULL);
      await c.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: admin })]);
      await c.query('SET LOCAL ROLE platform_admin');
      expect((await c.query('SELECT current_user AS u')).rows).toEqual([{ u: 'platform_admin' }]);
      await c.query('SAVEPOINT direct');
      const direct = await c.query('UPDATE company_invitations SET invited_by = NULL WHERE id = $1', [sender.invite])
        .then(() => 'written', (e: { code?: string }) => e.code);
      expect(direct).toBe('RC008');
      await c.query('ROLLBACK TO SAVEPOINT direct');
      expect((await c.query('SELECT id FROM company_invitations WHERE invited_by = $1', [sender.id])).rows)
        .toEqual([{ id: sender.invite }]); // platform_admin reads it (deleteUser's attribution read)
      await c.query('DELETE FROM company_users WHERE user_id = $1', [sender.id]);
      expect((await c.query('DELETE FROM users WHERE id = $1', [sender.id])).rowCount).toBe(1);
      await c.query('RESET ROLE');
      expect((await c.query('SELECT invited_by FROM company_invitations WHERE id = $1', [sender.invite])).rows)
        .toEqual([{ invited_by: null }]);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});

/** A sender and its invitation, written on `c` (inside its transaction). */
async function inviterOn(c: PoolClient): Promise<{ id: string; invite: string }> {
  const id = crypto.randomUUID();
  await c.query(`INSERT INTO users (id, email, role, is_active) VALUES ($1, $2, 'viewer', true)`, [id, `${id}@test.local`]);
  await c.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1, $2, 'admin')`, [company, id]);
  const r = await c.query(`INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
    VALUES ($1, $2, 'viewer', $3, $4, NOW() + interval '1 day') RETURNING id`,
  [company, `own-${id}@test.local`, id, hashInviteToken(`own-${id}`)]);
  return { id, invite: r.rows[0].id as string };
}

describe('997c: lock order against the legacy accept (invitation row first)', () => {
  it('an accept holding the invitation row commits; the DELETE of its sender waits, then answers 200', async () => {
    const invitee = identity();
    const sender = await inviter([[invitee.email, false]]);
    const inv = sender.invites[0]!.id;
    const c = await fixture.connect();
    let deleting: ReturnType<typeof deleteUser> | undefined;
    try {
      // pages/api/invite/[token].ts, statement for statement, as its transaction runs them.
      await c.query('BEGIN');
      await c.query('SELECT id FROM company_invitations WHERE id = $1 AND accepted_at IS NULL FOR UPDATE', [inv]);
      deleting = deleteUser(sender.id);
      await waitForLockWait('DELETE FROM users');
      await c.query(`INSERT INTO company_users (company_id, user_id, role) VALUES ($1::uuid, $2::uuid, 'viewer')
        ON CONFLICT (company_id, user_id) DO UPDATE SET role = EXCLUDED.role`, [company, invitee.id]);
      await c.query(`INSERT INTO users (id, email, is_active, status, onboarding_completed) VALUES ($1, $2, true, 'active', true)`,
        [invitee.id, invitee.email]);
      await c.query('UPDATE company_invitations SET accepted_at = NOW() WHERE id = $1::uuid', [inv]);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally {
      c.release();
    }
    const r = await deleting!;
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [row] = await invitationsBy([inv]);
    expect(row).toMatchObject({ invited_by: null });
    expect(row!.accepted_at).not.toBeNull();
    expect(await q('SELECT role FROM company_users WHERE company_id = $1 AND user_id = $2', [company, invitee.id]))
      .toEqual([{ role: 'viewer' }]);
  }, 20000);
});

/** Until a backend running `prefix` waits on a lock (10 s at most). */
async function waitForLockWait(prefix: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const r = await q(`SELECT count(*)::int n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE $1`, [`${prefix}%`]);
    if (r[0]!.n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`no backend running "${prefix}" waited on a lock`);
}

const shape = async (c: PoolClient) => (await c.query(
  `SELECT c.confdeltype, c.confupdtype, c.convalidated, pg_get_constraintdef(c.oid) AS def,
          (SELECT a.attnotnull FROM pg_attribute a WHERE a.attrelid = c.conrelid AND a.attname = 'invited_by') AS notnull
     FROM pg_constraint c WHERE c.conname = $1 AND c.conrelid = 'company_invitations'::regclass`, [FK])).rows;
const SET_NULL = [{ confdeltype: 'n', confupdtype: 'a', convalidated: true, notnull: false,
  def: 'FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE SET NULL' }];
/** Back to master's shape, NOT NULL and NO ACTION, inside `c`'s transaction (rows with no sender cannot exist there). */
async function toMasterShape(c: PoolClient): Promise<void> {
  await c.query('DELETE FROM company_invitations WHERE invited_by IS NULL');
  await c.query(`ALTER TABLE company_invitations DROP CONSTRAINT ${FK}`);
  await c.query(`ALTER TABLE company_invitations ADD CONSTRAINT ${FK} FOREIGN KEY (invited_by) REFERENCES users(id)`);
  await c.query('ALTER TABLE company_invitations ALTER COLUMN invited_by SET NOT NULL');
}

describe('997c: the migration', () => {
  it('is applied, converts the old NO ACTION / NOT NULL shape, and a rerun changes nothing', async () => {
    const c = await fixture.connect();
    try {
      await c.query('BEGIN');
      expect(await shape(c)).toEqual(SET_NULL);
      await toMasterShape(c);
      expect(await shape(c)).toEqual([{ ...SET_NULL[0], confdeltype: 'a', notnull: true,
        def: 'FOREIGN KEY (invited_by) REFERENCES users(id)' }]);
      await c.query(migration());
      expect(await shape(c)).toEqual(SET_NULL);
      const oid = (await c.query('SELECT oid FROM pg_constraint WHERE conname = $1', [FK])).rows;
      await c.query(migration());
      expect(await shape(c)).toEqual(SET_NULL);
      expect((await c.query('SELECT oid FROM pg_constraint WHERE conname = $1', [FK])).rows).toEqual(oid);
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });

  it('on production\'s shape (old FK NOT VALID, an invitation whose sender has no users row) NULLs only the orphan and validates', async () => {
    // 16 Nov 2026: the release stopped on dev with 23503 on company_invitations_invited_by_fkey; the old FK was NOT VALID.
    const sender = await inviter([[`kept-${crypto.randomUUID()}@test.local`, false]]);
    const c = await fixture.connect();
    try {
      await c.query('BEGIN');
      await toMasterShape(c);
      await c.query(`ALTER TABLE company_invitations DROP CONSTRAINT ${FK}`);
      const ghost = crypto.randomUUID();
      const orphan = (await c.query(`INSERT INTO company_invitations (company_id, email, role, invited_by, token, expires_at)
        VALUES ($1, $2, 'viewer', $3, $4, NOW() + interval '1 day') RETURNING id`,
      [company, `orphan-${ghost}@test.local`, ghost, hashInviteToken(`orphan-${ghost}`)])).rows[0]!.id as string;
      await c.query(`ALTER TABLE company_invitations ADD CONSTRAINT ${FK} FOREIGN KEY (invited_by) REFERENCES users(id) NOT VALID`);
      await c.query(migration());
      expect(await shape(c)).toEqual(SET_NULL);
      const rows = (await c.query('SELECT id, invited_by FROM company_invitations WHERE id = ANY($1::uuid[]) ORDER BY id',
        [[orphan, sender.invites[0]!.id]])).rows as Row[];
      expect(Object.fromEntries(rows.map((r) => [r.id, r.invited_by]))).toEqual({ [orphan]: null, [sender.invites[0]!.id]: sender.id });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  });
});
