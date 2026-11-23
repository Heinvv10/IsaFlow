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

describe('the lock bound is tighten-only and put back at every exit', () => {
  it.each(['500ms', '1s', '10s', '0'])('a caller bound of %s is what it was after a sent, an already-sent, a not-found, a no-link and a forbidden answer', async (timeout) => {
    const fresh = (await plantPaid(pool, (await plantBill(pool, conn)).bill)).allocation;
    const unlinked = (await plantPaid(pool, (await plantBill(pool, conn, { link: false })).bill)).allocation;
    expect((await probe(timeout, fresh)).answer.message_id).toBeTruthy();
    const rest = [
      [fresh, U.b, 'already_sent'], [crypto.randomUUID(), U.b, 'not_found'], [unlinked, U.b, 'no_link'], [fresh, U.avb, 'forbidden'],
    ] as const;
    for (const [allocation, user, reason] of rest) {
      const { answer, after } = await probe(timeout, allocation, user);
      expect(answer.reason, reason).toBe(reason);
      expect(after, reason).toBe(timeout);
    }
    expect((await probe(timeout, fresh)).after).toBe(timeout);
  });

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
    expect(ms).toBeLessThan(6000);
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
      // it waits on the winner's unique-index entry
      for (let i = 0; i < 250; i += 1) {
        const waiting = await pool.query("SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE '%intercompany_send_for_allocation%'");
        if (waiting.rowCount) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await winner.query('COMMIT');
      expect(await loser).toEqual({ message_id: null, reason: 'already_sent', detail: null });
    } finally {
      await winner.query('ROLLBACK').catch(() => undefined);
      winner.release();
    }
    expect(await allocationMessages(pool)).toHaveLength(1);
  }, 30000);
});
