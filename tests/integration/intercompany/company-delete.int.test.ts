/**
 * Intercompany (1002): deleting a company that is a party to live connections and has a lock row (its memberships removed first, as
 * an admin does). The connections, their sides, messages and links, and the lock row all go with it (foreign keys that cascade);
 * nothing else stalls; a decider that holds the company's lock row makes the delete wait for it (documented) and for no one else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser, cleanup, plantConnection, plantSide, setup, U } from './intercompany.helpers';
import { companies } from './intercompany.fixture';
import { makeRace } from './group-race.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const { inFlight, openSession, sleep, settle } = makeRace(pool);

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));

const ASK = 'SELECT public.intercompany_in_one_group($1, $2), pg_sleep(0)';
const SEND = "INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload) VALUES ($1, $2, $3, 'payment', 'payment', gen_random_uuid(), '{}')";
const count = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0].n as number;

async function world() {
  const mk = async (name: string) => {
    const id = crypto.randomUUID();
    await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [id, `IC delete ${name}`]);
    await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'owner')", [id, U.ab]);
    companies.push(id);
    return id;
  };
  const [x, y, z] = [await mk('x'), await mk('y'), await mk('z')];
  const groups: string[] = [];
  for (const members of [[x, y], [y, z]]) {
    const g = crypto.randomUUID();
    groups.push(g);
    await pool.query("INSERT INTO company_groups(id, name) VALUES ($1, 'IC delete group')", [g]);
    await pool.query('INSERT INTO company_group_members(group_id, company_id) SELECT $1, m FROM unnest($2::uuid[]) m', [g, members]);
  }
  const xy = await plantConnection(pool, x, y, U.ab);
  const yz = await plantConnection(pool, y, z, U.ab);
  await plantSide(pool, xy, x, y, { auto_accept: true }, U.ab);
  await asAppUser(pool, U.ab, x, (q) => q.query(SEND, [xy, x, y]), true);
  return { x, y, z, xy, yz, groups };
}
async function sendYZ(w: { y: string; z: string; yz: string }) {
  const s = await openSession(U.ab, w.y);
  try {
    await s.query("SET LOCAL lock_timeout = '1500ms'");
    await s.query(SEND, [w.yz, w.y, w.z]);
    await s.query('COMMIT');
  } finally {
    await s.query('ROLLBACK').catch(() => undefined);
    s.release();
  }
}
async function drop(w: Awaited<ReturnType<typeof world>>) {
  await pool.query('DELETE FROM intercompany_connections WHERE company_low_id = ANY($1) OR company_high_id = ANY($1)', [[w.x, w.y, w.z]]);
  await pool.query('DELETE FROM company_groups WHERE id = ANY($1)', [w.groups]);
}

describe('deleting a company that is a party to live connections', () => {
  it('its memberships are removed first (which ends x-y), then the company goes: connection, sides, messages and lock row cascade, and y-z is untouched', async () => {
    const w = await world();
    try {
      expect(await count('SELECT count(*)::int AS n FROM intercompany_company_locks WHERE company_id = $1', [w.x])).toBe(1);
      await pool.query('DELETE FROM company_group_members WHERE company_id = $1', [w.x]);                    // the admin's first step
      expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [w.xy])).rows[0].status).toBe('revoked');
      const t0 = Date.now();
      await pool.query('DELETE FROM companies WHERE id = $1', [w.x]);
      expect(Date.now() - t0).toBeLessThan(2000);
      expect(await count('SELECT count(*)::int AS n FROM intercompany_connections WHERE id = $1', [w.xy])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM intercompany_connection_sides WHERE connection_id = $1', [w.xy])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM intercompany_messages WHERE connection_id = $1', [w.xy])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM intercompany_company_locks WHERE company_id = $1', [w.x])).toBe(0);
      expect((await pool.query('SELECT status FROM intercompany_connections WHERE id = $1', [w.yz])).rows[0].status).toBe('active');
      await sendYZ(w);                                                                                         // nothing else stalls
    } finally {
      await drop(w);
    }
  }, 60000);

  it('a session holding x\'s lock row makes the delete wait for it and for no one else: y-z sends go through, and the delete finishes once it lets go', async () => {
    const w = await world();
    await pool.query('DELETE FROM company_group_members WHERE company_id = $1', [w.x]);
    const holder = await inFlight(null, w.x, 'SELECT 1 FROM intercompany_company_locks WHERE company_id = $1 FOR SHARE', [w.x]);   // what a decider in flight holds
    try {
      const del = pool.connect().then(async (c) => { try { return await settle(c.query('DELETE FROM companies WHERE id = $1', [w.x])); } finally { c.release(); } });
      await sleep(500);
      expect(await count('SELECT count(*)::int AS n FROM companies WHERE id = $1', [w.x])).toBe(1);            // still waiting
      await sendYZ(w);
      await holder.query('ROLLBACK');
      expect(await del).toBe('ok');
      expect(await count('SELECT count(*)::int AS n FROM intercompany_company_locks WHERE company_id = $1', [w.x])).toBe(0);
      expect(await count('SELECT count(*)::int AS n FROM companies WHERE id = $1', [w.x])).toBe(0);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
      await drop(w);
    }
  }, 60000);
});
