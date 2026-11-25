/**
 * Intercompany P4-B: the definer waits at most 2 s for a lock and never LOOSENS the caller's bound (tighten-only), puts the caller's value
 * back at every exit, and two writers racing for one allocation row leave one message and an `already_sent` answer, not a unique violation.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { asAppUser } from './intercompany.helpers';
import { co, mirrorCleanup, U, wipeConnections } from './mirror.helpers';
import { allocSetup, allocationMessages, clearPayments, loanConnect, plantBill, plantPaid, type SendRow } from './allocation.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
let conn = '';

beforeAll(() => allocSetup(pool), 60000);
afterAll(async () => { await clearPayments(pool); await mirrorCleanup(pool); }, 60000);
beforeEach(async () => {
  await clearPayments(pool);
  await wipeConnections(pool);
  conn = await loanConnect(pool);
});

const CALL = 'SELECT * FROM public.intercompany_send_for_allocation($1)';
/** One call under the caller's `lock_timeout`: the answer, and the setting afterwards. */
const probe = (timeout: string, allocation: string, user = U.b) => asAppUser(pool, user, co.B, async (q) => {
  await q.query(`SET LOCAL lock_timeout = '${timeout}'`);
  const answer = (await q.query(CALL, [allocation])).rows[0] as SendRow;
  return { answer, after: (await q.query('SHOW lock_timeout')).rows[0].lock_timeout as string };
}, true);
/** The same with no session: `company` false = no session company, `claims` false = no signed-in user (app_user, the request role, as withAuth opens it). */
const probeNoSession = async (timeout: string, allocation: string, over: { company: boolean; claims: boolean }) => {
  const q = await pool.connect();
  try {
    await q.query('BEGIN');
    await q.query('SET LOCAL ROLE app_user');
    await q.query(`SET LOCAL lock_timeout = '${timeout}'`);
    if (over.company) await q.query("SELECT set_config('app.current_company_id', $1, true)", [co.B]);
    if (over.claims) await q.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.b })]);
    const answer = (await q.query(CALL, [allocation])).rows[0] as SendRow;
    const after = (await q.query('SHOW lock_timeout')).rows[0].lock_timeout as string;
    await q.query('COMMIT');
    return { answer, after };
  } catch (err) {
    await q.query('ROLLBACK');
    throw err;
  } finally {
    q.release();
  }
};
const setConnection = (set: string) => asAppUser(pool, U.ab, co.A, (q) => q.query(`UPDATE intercompany_connections SET ${set} WHERE id = $1`, [conn]), true);

/** Deterministic barrier: resolves once a backend of THIS database is waiting on a lock inside the definer (a poll on pg_stat_activity, bounded by elapsed time; not a sleep the outcome depends on).
 *  `settled` is the probe's own promise: if it settles first (an error, or an answer without any wait) the barrier fails with THAT, not with a misleading "never blocked". */
const waitUntilDefinerBlocked = async (settled: Promise<unknown>): Promise<void> => {
  let early: { error?: unknown } | null = null;
  void settled.then(() => { early = {}; }, (error: unknown) => { early = { error }; });
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (early) throw (early as { error?: unknown }).error ?? new Error('the definer answered without ever waiting on the held row');
    const r = await pool.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND wait_event_type = 'Lock'
          AND query LIKE '%intercompany_send_for_allocation%'`);
    if ((r.rowCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('the definer never blocked on a lock: the test setup did not overlap the writer');
};

describe('the lock bound is tighten-only and put back at every exit', () => {
  it.each(['500ms', '1s', '10s', '0'])('a caller bound of %s is what it was after EVERY exit: sent, already_sent, not_found, no_session, forbidden, no_link, not_posted, no_journal, before_cutover, no_cutover, not_loan, no_connection', async (timeout) => {
    const paid = async (over: Parameters<typeof plantPaid>[2] = {}, link = true) => (await plantPaid(pool, (await plantBill(pool, conn, { link })).bill, over)).allocation;
    const fresh = await paid();
    const exits: Array<[string, string, string | null, () => Promise<{ answer: SendRow; after: string }>]> = [];
    const as = (reason: string, allocation: string, user = U.b) => exits.push(['', reason, allocation, () => probe(timeout, allocation, user)]);
    expect((await probe(timeout, fresh)).answer.message_id).toBeTruthy();                         // sent
    const [draft, noJournal, early, unlinked] = [await paid({ status: 'draft' }), await paid({ journal: false }), await paid({ date: '2025-12-31' }), await paid({}, false)];
    as('already_sent', fresh); as('not_found', crypto.randomUUID()); as('forbidden', fresh, U.avb); as('no_link', unlinked);
    as('not_posted', draft); as('no_journal', noJournal); as('before_cutover', early);
    for (const [name, over] of [['no company', { company: false, claims: true }], ['no claims', { company: true, claims: false }], ['neither', { company: false, claims: false }]] as const) {
      exits.push([name, 'no_session', fresh, () => probeNoSession(timeout, fresh, over)]);
    }
    for (const [name, reason, , run] of exits) {
      const { answer, after } = await run();
      expect(answer.reason, `${name} ${reason}`).toBe(reason);
      expect(after, `${name} ${reason}`).toBe(timeout);
    }
    // the connection's own answers, one change at a time (the order of the checks)
    for (const [set, reason] of [['cutover_date = NULL', 'no_cutover'], ["cutover_date = DATE '2026-01-01', settlement_mode = 'cash'", 'not_loan'], ["status = 'revoked'", 'no_connection']] as const) {
      await setConnection(set);
      const { answer, after } = await probe(timeout, await paid());
      expect(answer.reason, reason).toBe(reason);
      expect(after, reason).toBe(timeout);
    }
    expect((await probe(timeout, fresh)).after).toBe(timeout);
  }, 60000);

  const blocked = async (timeout: string) => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT 1 FROM intercompany_connections WHERE id = $1 FOR UPDATE', [conn]);   // the message guard's FOR SHARE waits on it
      const t0 = Date.now();
      const err = await probe(timeout, allocation).then(() => null, (e: { code?: string }) => e);
      return { code: err?.code, ms: Date.now() - t0 };
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  };

  it('a caller with NO bound waits 2 s, not for ever: 55P03', async () => {
    const { code, ms } = await blocked('0');
    expect(code).toBe('55P03');
    expect(ms).toBeGreaterThanOrEqual(1500);
    expect(ms).toBeLessThan(3500);
  }, 30000);

  it('a caller bound tighter than 2 s is kept, not loosened to it', async () => {
    const { code, ms } = await blocked('500ms');
    expect(code).toBe('55P03');
    expect(ms).toBeLessThan(1500);
  }, 30000);
});

describe('two writers for one allocation row', () => {
  async function open(): Promise<PoolClient> {
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query('SET LOCAL ROLE app_user');
    await c.query("SELECT set_config('request.jwt.claims', $1, true)", [JSON.stringify({ sub: U.b })]);
    await c.query("SELECT set_config('app.current_company_id', $1, true)", [co.B]);
    return c;
  }

  it('the loser, which could not see the winner\'s uncommitted row, is told already_sent (ON CONFLICT DO NOTHING), not a unique violation', async () => {
    const { allocation } = await plantPaid(pool, (await plantBill(pool, conn)).bill);
    const winner = await open();
    try {
      expect(((await winner.query(CALL, [allocation])).rows[0] as SendRow).message_id).toBeTruthy();
      const loser = asAppUser(pool, U.b, co.B, async (q) => (await q.query(CALL, [allocation])).rows[0] as SendRow, true);
      // it waits on the winner's unique-index entry: SEEN waiting, or the test proves nothing (a loser that never overlapped the winner passes without ON CONFLICT)
      let seen = false;
      for (let i = 0; i < 250 && !seen; i += 1) {
        seen = ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%intercompany_send_for_allocation%'")).rowCount ?? 0) > 0;
        if (!seen) await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(seen).toBe(true);
      await winner.query('COMMIT');
      expect(await loser).toEqual({ message_id: null, reason: 'already_sent', detail: null });
    } finally {
      await winner.query('ROLLBACK').catch(() => undefined);
      winner.release();
    }
    expect(await allocationMessages(pool)).toHaveLength(1);
  }, 30000);
});

describe('the link and the connection are held FOR SHARE while the definer decides', () => {
  /** A payment dated before the cut-over: the definer answers before_cutover and never reaches its INSERT (whose guard would take the connection lock anyway). */
  const early = async () => {
    const { bill, link } = await plantBill(pool, conn);
    return { allocation: (await plantPaid(pool, bill, { date: '2025-12-31' })).allocation, link: link as string };
  };
  const hold = async (table: 'intercompany_connections' | 'intercompany_document_links', id: string) => {
    const holder = await pool.connect();
    await holder.query('BEGIN');
    await holder.query(`SELECT 1 FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);       // what an UPDATE of the row (a revoke, an unlink) takes
    return { release: async () => { await holder.query('ROLLBACK'); holder.release(); } };
  };

  it.each(['intercompany_connections', 'intercompany_document_links'] as const)('a change of the %s row in flight is waited for, and the answer follows once it is released', async (table) => {
    const { allocation, link } = await early();
    const held = await hold(table, table === 'intercompany_connections' ? conn : link);
    let released = false;
    const release = async () => { if (!released) { try { await held.release(); released = true; } catch { /* retried once in finally */ } } };
    const probing = probe('10s', allocation);
    try {
      await waitUntilDefinerBlocked(probing);          // SEEN waiting on the held row: no timing, and an answer before this point cannot happen
      await release();
      expect((await probing).answer.reason).toBe('before_cutover');
    } finally {
      await release();
      await probing.catch(() => undefined);
    }
  }, 30000);

  it.each(['intercompany_connections', 'intercompany_document_links'] as const)('one that is still in flight at the bound times out (55P03) with the 2 s bound, never waiting for ever (%s)', async (table) => {
    const { allocation, link } = await early();
    const held = await hold(table, table === 'intercompany_connections' ? conn : link);
    try {
      const t0 = Date.now();
      const err = await probe('0', allocation).then(() => null, (e: { code?: string }) => e);
      expect(err?.code).toBe('55P03');
      expect(Date.now() - t0).toBeLessThan(3500);
    } finally {
      await held.release();
    }
  }, 30000);
});

describe('a change that COMMITS while the definer waits is judged as it then stands', () => {
  /** The real change on its own session: made, then HELD uncommitted until `commit()` (no timer), so the definer is judged against a change that commits while it waits. */
  const changeUncommitted = async (user: string, company: string, statement: string, id: string) => {
    let made!: () => void;
    const madeIt = new Promise<void>((res) => { made = res; });
    let go!: () => void;
    const goOn = new Promise<void>((res) => { go = res; });
    const done = asAppUser(pool, user, company, async (q) => {
      const changed = await q.query(statement, [id]);
      expect(changed.rowCount, 'the change must hit exactly one row').toBe(1);
      made();
      await goOn;
    }, true);
    await Promise.race([madeIt, done]);                 // a failed setup rejects here with its own error instead of hanging
    return { commit: async () => { go(); await done; }, abandon: () => { go(); return done.catch(() => undefined); } };
  };
  const judgedAfterCommit = async (change: Awaited<ReturnType<typeof changeUncommitted>>, allocation: string) => {
    const probing = probe('10s', allocation);
    try {
      await waitUntilDefinerBlocked(probing);
      await change.commit();
      return (await probing).answer;
    } finally {
      await change.abandon();
      await probing.catch(() => undefined);
    }
  };

  it('a link UNLINKED meanwhile is no_link, and no message is written', async () => {
    const { bill, link } = await plantBill(pool, conn);
    const { allocation } = await plantPaid(pool, bill);
    const change = await changeUncommitted(U.b, co.B, "UPDATE intercompany_document_links SET status = 'unlinked' WHERE id = $1", link as string);
    const answer = await judgedAfterCommit(change, allocation);
    expect(answer.reason).toBe('no_link');
    expect(await allocationMessages(pool)).toHaveLength(0);
  }, 30000);

  it('a connection REVOKED meanwhile is no_connection, and no message is written', async () => {
    const { bill } = await plantBill(pool, conn);
    const { allocation } = await plantPaid(pool, bill);
    const change = await changeUncommitted(U.ab, co.A, "UPDATE intercompany_connections SET status = 'revoked' WHERE id = $1", conn);
    const answer = await judgedAfterCommit(change, allocation);
    expect(answer.reason).toBe('no_connection');
    expect(await allocationMessages(pool)).toHaveLength(0);
  }, 30000);
});
