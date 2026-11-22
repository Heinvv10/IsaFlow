/**
 * Intercompany P2, round 21 (hooks and queue):
 *  L2  the three hook definers bound their own lock waits at 2 s but NEVER loosen a tighter lock_timeout of their caller (cancelSupplierInvoice's
 *      underFlowLockBudget), and put the caller's value back on the way out (a function-level SET would have replaced it for the call);
 *  L3  two overlapping claims of the auto-accept queue never hand out the same message (FOR UPDATE SKIP LOCKED on the claim).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool, type PoolClient } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { co, rawReverseJournal, sentInvoice, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { asAppUser, asDefiner, outcome } from './intercompany.session';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
beforeAll(async () => { await L.setup(); }, 60000);
afterAll(L.cleanup, 60000);
beforeEach(L.reset);

/** Holds a row lock on the group row and on the message in another session until `release()`. */
async function hold(messageId: string) {
  const c = await pool.connect();
  await c.query('BEGIN');
  await c.query('SELECT id FROM intercompany_transactions WHERE group_id = $1 FOR UPDATE', [co.G]);
  await c.query('SELECT id FROM intercompany_messages WHERE id = $1 FOR UPDATE', [messageId]);
  let done = false;
  const release = async () => { if (done) return; done = true; await c.query('COMMIT'); c.release(); };
  return release;
}

/** The sender's cancel in the ledger only (no hook has run): the journal reversed raw, the invoice cancelled and unlinked, the message still pending/accepted. */
async function sentAndCancelledNoHook(m: Awaited<ReturnType<typeof L.accepted>>) {
  await rawReverseJournal(pool, m.message.source_journal_entry_id);
  await pool.query("UPDATE customer_invoices SET status = 'cancelled', gl_journal_entry_id = NULL WHERE id = $1", [m.inv.id]);
}

type Hook = { name: string; who: 'a' | 'b'; call: (m: Awaited<ReturnType<typeof L.accepted>>) => [string, unknown[]]; prep: (m: Awaited<ReturnType<typeof L.accepted>>) => Promise<void> };
const hooks: Hook[] = [
  { name: 'intercompany_sync_group_row', who: 'b', prep: async (m) => { await L.approveBill(m.bill); },
    call: (m) => ["SELECT public.intercompany_sync_group_row('supplier_invoice', $1)", [m.bill]] },
  { name: 'intercompany_withdraw_for_source', who: 'a', prep: async (m) => { await sentAndCancelledNoHook(m); },
    call: (m) => ["SELECT public.intercompany_withdraw_for_source('customer_invoice', $1)", [m.inv.id]] },
  { name: 'intercompany_journal_chain_changed', who: 'a', prep: async (m) => { await rawReverseJournal(pool, m.message.source_journal_entry_id); },
    call: (m) => ['SELECT public.intercompany_journal_chain_changed($1)', [m.message.source_journal_entry_id]] },
];

describe('L2: the hooks bound a lock wait, tighten-only', () => {
  it('no hook carries a function-level lock_timeout (a function SET replaces the caller\'s value for the call: it can only be a loosening or equal)', async () => {
    const r = await pool.query(`SELECT proname, coalesce(proconfig, '{}') AS c FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname = ANY($1) ORDER BY proname`, [hooks.map((h) => h.name)]);
    expect(r.rows.length).toBe(3);
    for (const x of r.rows) expect((x.c as string[]).some((c) => c.startsWith('lock_timeout')), x.proname).toBe(false);
  });

  it.each(hooks)('$name: a caller\'s 300 ms bound holds (the wait ends near 300 ms, not at the hook\'s 2 s), and the caller\'s value is back afterwards', async (h) => {
    const m = await L.accepted(); await h.prep(m);
    const release = await hold(m.id);
    try {
      const [text, args] = h.call(m);
      const seen = await asAppUser(pool, h.who === 'a' ? U.a : U.b, h.who === 'a' ? co.A : co.B, async (q: PoolClient) => {
        await q.query("SET LOCAL lock_timeout = '300ms'");
        const t0 = Date.now();
        const out = await outcome(q, text, args);
        return { out, ms: Date.now() - t0, after: (await q.query('SHOW lock_timeout')).rows[0].lock_timeout as string };
      });
      expect(seen.out).toMatch(/^55P03/);
      expect(seen.ms).toBeLessThan(1500);
      expect(seen.after).toBe('300ms');
    } finally { await release(); }
  }, 30000);

  it.each(hooks)('$name: with NO bound from the caller the hook gives up at about 2 s, never waits for the lock, and puts "no bound" back', async (h) => {
    const m = await L.accepted(); await h.prep(m);
    const release = await hold(m.id);
    const timer = setTimeout(() => { void release(); }, 9000);   // (a hook with no bound of its own returns when this lets go: the test then fails on the time)
    try {
      const [text, args] = h.call(m);
      const seen = await asAppUser(pool, h.who === 'a' ? U.a : U.b, h.who === 'a' ? co.A : co.B, async (q: PoolClient) => {
        await q.query("SET LOCAL lock_timeout = '0'");
        const t0 = Date.now();
        const out = await outcome(q, text, args);
        return { out, ms: Date.now() - t0, after: (await q.query('SHOW lock_timeout')).rows[0].lock_timeout as string };
      });
      expect(seen.out).toMatch(/^55P03/);
      expect(seen.ms).toBeGreaterThan(1500);
      expect(seen.ms).toBeLessThan(6000);
      expect(seen.after).toBe('0');
    } finally { clearTimeout(timer); await release(); }
  }, 30000);

  it.each(hooks)('$name: a hook that gets through (nothing held) does its work and leaves the caller\'s 300 ms bound in force', async (h) => {
    const m = await L.accepted(); await h.prep(m);
    const [text, args] = h.call(m);
    const seen = await asAppUser(pool, h.who === 'a' ? U.a : U.b, h.who === 'a' ? co.A : co.B, async (q: PoolClient) => {
      await q.query("SET LOCAL lock_timeout = '300ms'");
      const v = (await q.query(text, args)).rows[0] as Record<string, unknown>;
      return { done: Object.values(v)[0], after: (await q.query('SHOW lock_timeout')).rows[0].lock_timeout as string };
    });
    expect(seen.after).toBe('300ms');
    expect(seen.done).not.toBeFalsy();   // ('matched' / a count of 1 or more: the work was done, not refused)
  }, 30000);

  it('an unauthorised caller (no write role) is refused at once and leaves its lock_timeout alone', async () => {
    const seen = await asAppUser(pool, U.b, co.A, async (q: PoolClient) => {   // (B's user, A's company GUC: not a write role of A)
      await q.query("SET LOCAL lock_timeout = '7s'");
      const n = (await q.query("SELECT public.intercompany_sync_group_row('supplier_invoice', $1) AS s", [crypto.randomUUID()])).rows[0].s;
      return { n, after: (await q.query('SHOW lock_timeout')).rows[0].lock_timeout as string };
    });
    expect(seen).toEqual({ n: null, after: '7s' });
  });
});

describe('L3: two overlapping claims of the auto-accept queue', () => {
  const claim = async (q: PoolClient, limit: number) =>
    (await q.query('SELECT message_id FROM public.intercompany_auto_accept_queue($1, true)', [limit])).rows.map((r) => r.message_id as string);
  const attempts = async (ids: string[]) =>
    (await pool.query('SELECT id, auto_attempts FROM intercompany_messages WHERE id = ANY($1) ORDER BY id', [ids])).rows.map((r) => [r.id as string, r.auto_attempts as number]);

  it('while one claim holds messages, a second claim skips exactly those (never waits, never the same message twice); each is attempted once', async () => {
    await asAppUser(pool, U.b, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET auto_accept = true WHERE company_id = $1', [co.B]), true);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await sentInvoice(pool)).id);
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      await b.query("SET LOCAL lock_timeout = '1500ms'");   // (a claim that WAITS for a's rows fails here instead of hanging the suite)
      const first = await claim(a, 2);
      const second = await claim(b, 3);                    // (its pick includes a's two rows: it must skip them and take the third)
      expect(first).toHaveLength(2);
      expect(second).toHaveLength(1);
      expect(new Set([...first, ...second]).size).toBe(3);
      await a.query('COMMIT');
      await b.query('COMMIT');
    } finally { await a.query('ROLLBACK').catch(() => undefined); await b.query('ROLLBACK').catch(() => undefined); a.release(); b.release(); }
    expect((await attempts(ids)).map(([, n]) => n)).toEqual([1, 1, 1]);
    const again = await pool.connect();
    try { expect(await claim(again, 50)).toEqual([]); } finally { again.release(); }   // (every one is in its back-off now)
    expect((await attempts(ids)).map(([, n]) => n)).toEqual([1, 1, 1]);
  }, 30000);

  it('a claim that COMMITTED between another run\'s pick and its lock is seen after the wait: the second run skips the message (still at the attempt it read)', async () => {
    await asAppUser(pool, U.b, co.B, (q) => q.query('UPDATE intercompany_connection_sides SET auto_accept = true WHERE company_id = $1', [co.B]), true);
    const { id } = await sentInvoice(pool);
    const def = (await pool.query("SELECT pg_get_functiondef('public.intercompany_shared_group(uuid,uuid)'::regprocedure) AS d")).rows[0].d as string;
    // (the pick evaluates this once per candidate, after its snapshot: a pause between the pick and the lock)
    await pool.query(def.replace('SELECT p_a IS NOT NULL', 'SELECT pg_sleep(1.5) IS NOT NULL AND p_a IS NOT NULL'));
    const b = await pool.connect();
    try {
      const second = claim(b, 50);
      await new Promise((r) => setTimeout(r, 500));
      // (the other run's committed claim, written as the queue writes it: migration_admin through the guard's claim path)
      await asDefiner(pool, null, co.B, async (q) => {
        await q.query("SELECT set_config('app.intercompany_system_update', 'claim', true)");
        await q.query("UPDATE intercompany_messages SET auto_attempts = 1, auto_next_attempt_at = now() + interval '1 minute' WHERE id = $1", [id]);
      }, true);
      expect(await second).toEqual([]);
    } finally { b.release(); await pool.query(def); }
    expect((await attempts([id])).map(([, n]) => n)).toEqual([1]);
  }, 30000);
});
