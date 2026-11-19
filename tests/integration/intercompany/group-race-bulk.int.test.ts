/**
 * Intercompany (1002): the changers are statement-level triggers, so a statement that changes several memberships (a bulk leave)
 * locks ONE set, once. It must never hold part of it while it waits for the rest: that stalled sends in groups it shares nothing
 * with, and made an undetectable wait cycle with a transaction that held a company and waited for another. Two multi-row
 * statements that share a company must both finish. The lock set is narrowed to companies with a live connection to a leaver
 * (a viewer two hops away cannot veto a leave). A leave that cannot find a gap fails with 55P03 after its budget, and the
 * connection stays as it was.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { cleanup, setup, U } from './intercompany.helpers';
import { makeRace } from './group-race.helpers';
import { buildWorld, type World } from './group-world.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
const { openSession, inFlight, serialised, settle, sleep, connection, REVOKED } = makeRace(pool);

beforeAll(() => setup(pool), 60000);
afterAll(() => cleanup(pool));

const ASK = 'SELECT public.intercompany_in_one_group($1, $2), pg_sleep(0)';
const SEND = "INSERT INTO intercompany_messages(connection_id, from_company_id, to_company_id, kind, source_doc_type, source_doc_id, payload) VALUES ($1, $2, $3, 'payment', 'payment', gen_random_uuid(), '{}')";
const LEAVE_COMPANY = 'UPDATE company_group_members SET left_date = CURRENT_DATE WHERE company_id = $1';

async function withWorld(fn: (w: World) => Promise<void>) {
  const w = await buildWorld(pool);
  try { await fn(w); } finally { await w.drop(); }
}
/** A send on `id` from `from` to `to` with a 1.5 s lock timeout: a stall shows as an error. */
async function send(id: string, from: string, to: string) {
  const s = await openSession(U.ab, from);
  try {
    await s.query("SET LOCAL lock_timeout = '1500ms'");
    await s.query(SEND, [id, from, to]);
    await s.query('COMMIT');
  } finally {
    await s.query('ROLLBACK').catch(() => undefined);
    s.release();
  }
}

describe('a bulk leave holds nothing while it waits', () => {
  it('D leaves K and KQ in ONE statement while a session holds c (a company of the statement\'s set): while it polls it holds nothing, so sends on c-d, w-c and a-b go through', async () => {
    await withWorld(async (w) => {
      const holdC = inFlight(U.ab, w.b, ASK, [w.b, w.c]);                           // holds b and c FOR SHARE: c is in D's lock set
      const r = await serialised(holdC, (cl) => cl.query(LEAVE_COMPANY, [w.d]), undefined, async () => {
        await send(w.conn.cd, w.c, w.d);                                           // d and c are the leaver's own set: free, the changer holds none
        await send(w.conn.wc, w.w, w.c);
        await send(w.conn.ab, w.a, w.b);
      });
      expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
      expect((await connection(w.conn.dq)).status).toBe('revoked');
      expect((await connection(w.conn.cd)).status).toBe('revoked');
      expect((await connection(w.conn.ab)).status).toBe('active');
    });
  }, 60000);

  it('a transaction that holds b and c and then needs d (the wait cycle) is not stalled by the bulk leave that polls for c', async () => {
    await withWorld(async (w) => {
      const t = await openSession(U.ab, w.b);
      const bulk = await pool.connect();
      try {
        await t.query("SET LOCAL lock_timeout = '2s'");
        await t.query(SEND, [w.conn.bc, w.b, w.c]);                                 // holds b and c FOR SHARE
        const pid = (await bulk.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
        let done = false;
        const bulkRun = settle(bulk.query(LEAVE_COMPANY, [w.d])).then((x) => { done = true; return x; });
        await sleep(300);
        expect((await pool.query("SELECT wait_event FROM pg_stat_activity WHERE pid = $1", [pid])).rows[0]?.wait_event).toBe('PgSleep');
        await t.query("SELECT set_config('app.current_company_id', $1, true)", [w.c]);
        await t.query(SEND, [w.conn.cd, w.c, w.d]);                                // needs d: free, because the bulk holds nothing
        await t.query('COMMIT');
        expect(await bulkRun).toBe('ok');
        expect(done).toBe(true);
        expect((await connection(w.conn.cd)).status).toBe('revoked');
      } finally {
        await t.query('ROLLBACK').catch(() => undefined);
        t.release();
        bulk.release();
      }
    });
  }, 60000);

  it('two multi-row statements that share a company both finish (no wait cycle, no 55P03), and everything they could end is ended', async () => {
    await withWorld(async (w) => {
      const [x, y] = await Promise.all([pool.connect(), pool.connect()]);
      try {
        const t0 = Date.now();
        const results = await Promise.all([settle(x.query(LEAVE_COMPANY, [w.d])), settle(y.query(LEAVE_COMPANY, [w.c]))]);
        expect(results).toEqual(['ok', 'ok']);
        expect(Date.now() - t0).toBeLessThan(15000);
      } finally {
        x.release();
        y.release();
      }
      for (const id of [w.conn.bc, w.conn.cd, w.conn.dq, w.conn.fc, w.conn.wc]) expect((await connection(id)).status, id).toBe('revoked');
      expect((await connection(w.conn.ab)).status).toBe('active');
    });
  }, 60000);
});

describe('a statement that changes two companies holds neither set while the other is busy (both orders are tried)', () => {
  // d and b leave in one statement. d's set is {d, q, c}, b's set is {b, c}. Whichever the trigger would try first, a holder of the OTHER
  // set's private company must not make it keep the first set: sends on the first set's companies must go through. The two cases
  // together catch a changer that keeps what it took while it waits, whatever the ids happen to sort like.
  it.each([
    ['a viewer holds (a, b): b is private to b\'s set', (w: World) => ({ holder: [U.va, w.a, w.b] as const, probes: [[w.conn.wc, w.w, w.c], [w.conn.dq, w.q, w.d]] as const })],
    ['a viewer of q holds (q, d): q and d are private to d\'s set', (w: World) => ({ holder: [U.va, w.q, w.d] as const, probes: [[w.conn.ab, w.a, w.b], [w.conn.bc, w.b, w.c]] as const })],
  ])('%s', async (_label, plan) => {
    await withWorld(async (w) => {
      const { holder: [user, x, y], probes } = plan(w);
      const held = await inFlight(user, x, ASK, [x, y]);
      const r = await serialised(Promise.resolve(held), (cl) => cl.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE company_id = ANY($1)', [[w.d, w.b]]), undefined, async () => {
        for (const [id, from, to] of probes) await send(id, from, to);
      });
      expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
    });
  }, 60000);
});

describe('the candidate connections are not waited for while another is held (both orders)', () => {
  it.each([['cd held, a send on dq goes through', 'cd', 'dq'], ['dq held, a send on cd goes through', 'dq', 'cd']] as const)('%s', async (_label, heldKey, probeKey) => {
    await withWorld(async (w) => {
      const sender = { cd: [w.c, w.d], dq: [w.d, w.q] } as const;
      const held = await openSession(U.ab, sender[heldKey][0]);
      try {
        await held.query(SEND, [w.conn[heldKey], sender[heldKey][0], sender[heldKey][1]]);      // holds that connection FOR SHARE and its two companies
        const leaver = await pool.connect();
        try {
          const pid = (await leaver.query('SELECT pg_backend_pid() AS pid')).rows[0].pid as number;
          const run = settle(leaver.query(LEAVE_COMPANY, [w.d]));
          await sleep(400);
          expect((await pool.query('SELECT wait_event FROM pg_stat_activity WHERE pid = $1', [pid])).rows[0]?.wait_event).toBe('PgSleep');   // polling, not blocked
          await send(w.conn[probeKey], sender[probeKey][0], sender[probeKey][1]);                // the other candidate: free, nobody holds it
          await held.query('COMMIT');
          expect(await run).toBe('ok');
        } finally {
          leaver.release();
        }
      } finally {
        await held.query('ROLLBACK').catch(() => undefined);
        held.release();
      }
    });
  }, 60000);
});

describe('the lock set is narrowed to companies with a live connection to a leaver', () => {
  it('a viewer of q holds (q, d); F leaves G2: d has no connection to f, so the leave is not held up and ends f-c', async () => {
    await withWorld(async (w) => {
      const viewer = await inFlight(U.va, w.q, ASK, [w.q, w.d]);
      try {
        const leaver = await pool.connect();
        try {
          await leaver.query("SET lock_timeout = '1500ms'");
          const t0 = Date.now();
          await leaver.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [w.G2, w.f]);
          expect(Date.now() - t0).toBeLessThan(1500);
        } finally {
          leaver.release();
        }
        expect((await connection(w.conn.fc)).status).toBe('revoked');              // f-c shared only G2: the leave ended it, without a wait
      } finally {
        await viewer.query('ROLLBACK');
        viewer.release();
      }
    });
  }, 60000);

  it('a viewer of a holds (a, b); B leaves K: b-c is ended, a-b is not a candidate; the leave waits for b only because b IS the leaver', async () => {
    await withWorld(async (w) => {
      const r = await serialised(inFlight(U.va, w.a, ASK, [w.a, w.b]),
        (cl) => cl.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [w.K, w.b]));
      expect(r).toEqual({ waited: 'poll', firstEnd: 'ok', second: 'ok' });
      expect((await connection(w.conn.bc)).status).toBe('revoked');
      expect((await connection(w.conn.ab)).status).toBe('active');
    });
  }, 60000);
});

describe('the retry backs off exponentially (a backend holds at most 64 sub-transactions before its subxid cache overflows)', () => {
  it('a leave that waits about 1.5 s takes a handful of attempts, not a hundred', async () => {
    await withWorld(async (w) => {
      const holder = await inFlight(U.ab, w.a, ASK, [w.a, w.b]);
      const leaver = await pool.connect();
      try {
        await leaver.query('BEGIN');
        const run = leaver.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [w.gAB, w.b]);
        await sleep(1500);
        await holder.query('ROLLBACK');
        await run;
        const attempts = Number((await leaver.query("SELECT current_setting('app.intercompany_changer_attempts') AS n")).rows[0].n);
        expect(attempts).toBeGreaterThanOrEqual(3);
        expect(attempts).toBeLessThanOrEqual(14);                                        // linear 5-25 ms sleeps took ~100 in the same time
        await leaver.query('COMMIT');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
        await leaver.query('ROLLBACK').catch(() => undefined);
        leaver.release();
      }
    });
  }, 60000);
});

describe('the attempt cap bounds the retry whatever the clock', () => {
  it('with a 30 s budget but a cap of 4 attempts the leave fails with 55P03 within a second or two, and nothing changed', async () => {
    await withWorld(async (w) => {
      const holder = await inFlight(U.ab, w.a, ASK, [w.a, w.b]);
      const leaver = await pool.connect();
      try {
        await leaver.query("SET app.intercompany_changer_budget_ms = '30000'");
        await leaver.query("SET app.intercompany_changer_max_attempts = '4'");
        const t0 = Date.now();
        const error = await leaver.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [w.gAB, w.b]).then(() => null, (e: { code: string; message: string }) => e);
        expect(error).toMatchObject({ code: '55P03' });
        expect(error?.message).toMatch(/try again in a moment/);
        expect(Date.now() - t0).toBeLessThan(2500);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        leaver.release();
      }
      expect((await pool.query('SELECT left_date FROM company_group_members WHERE group_id = $1 AND company_id = $2', [w.gAB, w.b])).rows[0].left_date).toBeNull();
    });
  }, 60000);
});

describe('a leave that cannot find a gap gives up cleanly after its budget', () => {
  it('holder keeps a and b; the leave of b fails with 55P03 after about the budget, the membership and the connection are as they were', async () => {
    await withWorld(async (w) => {
      const holder = await inFlight(U.ab, w.a, ASK, [w.a, w.b]);
      const leaver = await pool.connect();
      try {
        await leaver.query("SET app.intercompany_changer_budget_ms = '600'");
        const t0 = Date.now();
        const error = await leaver.query('UPDATE company_group_members SET left_date = CURRENT_DATE WHERE group_id = $1 AND company_id = $2', [w.gAB, w.b]).then(() => null, (e: { code: string; message: string }) => e);
        const took = Date.now() - t0;
        expect(error).toMatchObject({ code: '55P03' });
        expect(error?.message).toMatch(/try again in a moment/);
        expect(took).toBeGreaterThanOrEqual(550);
        expect(took).toBeLessThan(5000);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
        leaver.release();
      }
      expect((await pool.query('SELECT left_date FROM company_group_members WHERE group_id = $1 AND company_id = $2', [w.gAB, w.b])).rows[0].left_date).toBeNull();
      expect((await connection(w.conn.ab)).status).toBe('active');
    });
  }, 60000);
});
