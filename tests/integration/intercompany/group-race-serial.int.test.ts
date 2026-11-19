/**
 * Intercompany (1002): two membership changes at the same moment (each sees the other's change uncommitted: write skew), a group
 * deactivation that has to wait, and a re-activation, an auto-accept switch or a message accept racing a leave. Each case ends
 * serialised, in both orders, with no 40P01 (deadlock) and the invariant holding. Two real connections per test.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { companies } from './intercompany.fixture';
import { asAppUser, cleanup, co, plantConnection, plantMessage, plantSide, R, setup, U, wipeConnections } from './intercompany.helpers';
import { makeRace } from './group-race.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 6 });
const {
  openSession, LEAVE, INSERT, withSecondGroup, sharing, connection, inFlight, serialised, leaving, deactivating, leave, deactivate, REVOKED,
} = makeRace(pool);

beforeAll(() => setup(pool), 60000);
afterAll(async () => {
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
  await cleanup(pool);
});
beforeEach(async () => {
  await wipeConnections(pool);
  await pool.query('UPDATE company_group_members SET left_date = NULL WHERE group_id = $1', [co.G]);
});

describe('two membership changes at the same moment (write skew)', () => {
  it.each([['A leaves H, then B leaves G', 0], ['B leaves G, then A leaves H', 1]])(
    'concurrent double leave, no shared group left: %s: the second waits, then both are done and the connection is revoked', async (_label, which) => {
      await withSecondGroup(async (h) => {
        const id = await plantConnection(pool, co.A, co.B);
        const steps: Array<[string, string]> = [[co.A, h], [co.B, co.G]];
        const [x, y] = which === 0 ? steps : [steps[1], steps[0]];
        const r = await serialised(leaving(x[0], x[1]), leave(y[0], y[1]));
        expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
        expect(await sharing()).toBe(false);
        expect(await connection(id)).toEqual(REVOKED);
      });
    }, 30000);

  it('control: the same two leaves one after the other revoke too', async () => {
    await withSecondGroup(async (h) => {
      const id = await plantConnection(pool, co.A, co.B);
      await pool.query(LEAVE, [h, co.A]);
      expect((await connection(id)).status).toBe('active');
      await pool.query(LEAVE, [co.G, co.B]);
      expect((await connection(id)).status).toBe('revoked');
    });
  }, 30000);

  it('two leaves that leave a shared group behind revoke nothing (the lock does not over-revoke)', async () => {
    await withSecondGroup(async (h) => {
      const id = await plantConnection(pool, co.A, co.B);
      const r = await serialised(leaving(co.A, h), leave(co.B, h));
      expect(r.second).toBe('ok');
      expect(await sharing()).toBe(true);                       // both still share G
      expect((await connection(id)).status).toBe('active');
    });
  }, 30000);

  it.each([['H then G', 0], ['G then H', 1]])('concurrent double group deactivation (%s): the second waits, then the connection is revoked', async (_label, which) => {
    await withSecondGroup(async (h) => {
      const id = await plantConnection(pool, co.A, co.B);
      const [x, y] = which === 0 ? [h, co.G] : [co.G, h];
      const r = await serialised(deactivating(x), deactivate(y));
      expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
      expect(await sharing()).toBe(false);
      expect(await connection(id)).toEqual(REVOKED);
    });
  }, 30000);

  it.each([['the leave first', true], ['the deactivation first', false]])('a leave and a group deactivation at the same moment: %s', async (_label, leaveFirst) => {
    await withSecondGroup(async (h) => {
      const id = await plantConnection(pool, co.A, co.B);
      const r = leaveFirst ? await serialised(leaving(co.B, co.G), deactivate(h)) : await serialised(deactivating(h), leave(co.B, co.G));
      expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
      expect(await connection(id)).toEqual(REVOKED);
    });
  }, 30000);
});

describe('a group deactivation that has to wait', () => {
  it('re-reads the members once it holds the lock: companies that joined the group meanwhile, and the connection they made, are revoked too', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.A, co.B, {}, U.a);
    const extra: string[] = [];
    for (const name of ['X1', 'X2']) {
      const c = crypto.randomUUID();
      await pool.query('INSERT INTO companies(id, name) VALUES ($1, $2)', [c, `IC race ${name} ${c.slice(0, 6)}`]);
      await pool.query("INSERT INTO company_users(company_id, user_id, role) VALUES ($1, $2, 'owner')", [c, U.ac]);
      extra.push(c);
      companies.push(c);
    }
    let late = '';
    try {
      // the deactivation reads {A, B}, then waits for A's side row, which a writer holds
      const r = await serialised(
        inFlight(U.a, co.A, 'UPDATE intercompany_connection_sides SET auto_accept = auto_accept WHERE connection_id = $1 AND company_id = $2', [id, co.A]),
        deactivate(co.G), undefined,
        async () => {
          await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2), ($1, $3)', [co.G, extra[0], extra[1]]);
          late = await plantConnection(pool, extra[0], extra[1], U.ac);
        });
      expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
      expect(await connection(id)).toEqual(REVOKED);
      expect(await connection(late)).toEqual(REVOKED);
    } finally {
      await pool.query('DELETE FROM intercompany_connection_sides WHERE connection_id = $1', [late || id]);
      await pool.query('DELETE FROM intercompany_connections WHERE id = $1', [late || id]);
      await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = ANY($2)', [co.G, extra]);
      await pool.query('UPDATE company_groups SET is_active = true WHERE id = $1', [co.G]);
    }
  }, 30000);
});

describe('a re-activation and a leave at the same moment', () => {
  const revoked = async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await asAppUser(pool, U.ab, co.A, (q) => q.query("UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", [id]), true);
    return id;
  };
  const REACTIVATE = "UPDATE intercompany_connections SET status = 'active' WHERE id = $1";

  it('the re-activation holds its row and the lock first: the leave waits (no deadlock), then revokes it again', async () => {
    const id = await revoked();
    const r = await serialised(inFlight(U.ab, co.A, REACTIVATE, [id]), leave(co.B, co.G));
    expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
    expect(await connection(id)).toEqual(REVOKED);
  }, 30000);

  it('the leave comes first: the re-activation waits for it, then is refused (no group left)', async () => {
    const id = await revoked();
    const r = await serialised(leaving(co.B, co.G), (c) => c.query(REACTIVATE, [id]), openSession(U.ab, co.A));
    expect(r).toEqual({ waited: 'lock', firstEnd: 'ok', second: R.needsOneGroup });
    expect((await connection(id)).status).toBe('revoked');
  }, 30000);
});

describe('switching auto-accept on and a leave at the same moment', () => {
  const side = async (id: string) => (await pool.query('SELECT auto_accept FROM intercompany_connection_sides WHERE connection_id = $1 AND company_id = $2', [id, co.B])).rows[0];
  const ON = 'UPDATE intercompany_connection_sides SET auto_accept = true WHERE connection_id = $1 AND company_id = $2';

  it('the side update holds its row first: the leave waits for it (no deadlock), then revokes and switches auto-accept off', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.B, co.A, {}, U.b);
    const r = await serialised(inFlight(U.b, co.B, ON, [id, co.B]), leave(co.B, co.G));
    expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
    expect(await connection(id)).toEqual(REVOKED);
    expect((await side(id)).auto_accept).toBe(false);
  }, 30000);

  it('the leave comes first: the side update waits, then is refused (the connection is revoked)', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    await plantSide(pool, id, co.B, co.A, {}, U.b);
    const r = await serialised(leaving(co.B, co.G), (c) => c.query(ON, [id, co.B]), openSession(U.b, co.B));
    expect(r.waited).toBe('lock');
    expect(r.second).toBe(R.sideRevoked);
    expect((await side(id)).auto_accept).toBe(false);
  }, 30000);
});

describe('accepting a message and a leave at the same moment', () => {
  it('the leave waits for the accepting transaction, then revokes the connection; the accepted message stays accepted', async () => {
    const id = await plantConnection(pool, co.A, co.B);
    const m = await plantMessage(pool, id, co.A, co.B, { kind: 'payment' });
    const r = await serialised(inFlight(U.b, co.B, "UPDATE intercompany_messages SET status = 'accepted' WHERE id = $1", [m]), leave(co.B, co.G));
    expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
    expect((await connection(id)).status).toBe('revoked');
    expect((await pool.query('SELECT status FROM intercompany_messages WHERE id = $1', [m])).rows[0].status).toBe('accepted');
  }, 30000);
});
