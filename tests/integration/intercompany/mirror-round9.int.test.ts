/**
 * Intercompany P2, round 9 (the round-8 breaker review):
 *  M1  a writer's OWN row naming another pair's receiver journal moves no figure: a third group member C, or the sender A, inserting a row whose
 *      target is B's bound journal is refused at INSERT (intercompany_journal_claimed); and a row planted with such a target anyway (a legacy
 *      manual row, or the hook-free path) holds nothing, because the exclusivity checks count only what the DATABASE bound
 *      (intercompany_journal_bound_elsewhere);
 *  M2  the exclusivity lookups use their indexes (no scan of every tenant's rows).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { assertDisposable } from '../mfa-impersonation-postgres.helpers';
import { co, groupAccounts as ga, U } from './mirror.helpers';
import { makeLedger } from './ledger.helpers';
import { asAppUser, outcome, withoutTrigger } from './intercompany.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 8 });
const L = makeLedger(pool);
const { derived, approveBill, accepted } = L;
beforeAll(async () => {
  await L.setup();
  await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [co.G, co.C]);   // C: a third member of G
}, 60000);
afterAll(async () => {
  await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2', [co.G, co.C]);
  await L.cleanup();
}, 60000);
beforeEach(L.reset);

const net = async () => {
  const all = (await derived()).flatMap((e) => e.lines);
  const sum = (id: string) => all.filter((l) => l.groupAccountId === id).reduce((n, l) => n + l.debit - l.credit, 0);
  return { rev: sum(ga.rev), exp: sum(ga.exp) };
};
const insertRow = (from: string, to: string, je: string, description: string) =>
  `INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, transaction_date, description, target_journal_entry_id)
   VALUES ('${co.G}', '${from}', '${to}', 'management_fee', 1, 'ZAR', '2026-09-20', '${description}', '${je}')`;

describe('M1: a writer\'s row naming another pair\'s receiver journal', () => {
  it.each([
    ['a third group member C (C -> B), reading the journal id through RLS', () => U.c, () => co.C, () => co.C],
    ['the sender A (A -> B)', () => U.a, () => co.A, () => co.A],
  ] as const)('%s: the INSERT is refused and the A<->B elimination stands', async (_name, user, company, from) => {
    const m = await accepted();
    await approveBill(m.bill);
    const before = await net();
    expect(before).toEqual({ rev: 1000, exp: -1000 });
    const res = await asAppUser(pool, user(), company(), async (q) => {
      const j = (await q.query('SELECT target_journal_entry_id AS t FROM intercompany_transactions WHERE group_id = $1 AND source_company_id = $2', [co.G, co.A])).rows[0]?.t as string;
      expect(j, 'a group member reads the bound journal id').toBeTruthy();
      return outcome(q, insertRow(from(), co.B, j, 'forge'));
    }, true);
    expect(res).toMatch(/^23514: intercompany_transactions: the target journal is already another transaction's or a mirrored document's/);
    expect(await net()).toEqual(before);
  });

  it('before the receiver binds it: a row naming the journal of a bill an accepted message created is refused too', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    await L.unbind();   // (the hook never ran: nothing holds the journal but the mirrored bill's link)
    const j = (await pool.query('SELECT gl_journal_entry_id AS je FROM supplier_invoices WHERE id = $1', [m.bill])).rows[0].je as string;
    const res = await asAppUser(pool, U.c, co.C, (q) => outcome(q, insertRow(co.C, co.B, j, 'forge')), true);
    expect(res).toMatch(/^23514: /);
    expect(await net()).toEqual({ rev: 1000, exp: -1000 });
  });

  it('a row that names the journal anyway (planted, as a legacy manual row would) holds nothing: bound or hook-free, the elimination stands', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const j = (await L.groupRow()).target_journal_entry_id as string;
    await withoutTrigger(pool, 'intercompany_transactions', 'trg_intercompany_transaction_recorded_fresh', (q) => q.query(insertRow(co.C, co.B, j, 'legacy')));
    expect(await net()).toEqual({ rev: 1000, exp: -1000 });   // the first-match path
    await L.unbind();
    expect(await net()).toEqual({ rev: 1000, exp: -1000 });   // the document path (intercompany_receiver_journal_problem)
    expect(await L.sync(U.b, co.B, m.bill)).toBe('matched');   // and the receiver's sync still binds it
  });
});

describe('M2: the exclusivity lookups use their indexes', () => {
  it('intercompany_journal_bound_elsewhere reads the first-match and target indexes, never a sequential scan of the table', async () => {
    const c = await pool.connect();
    try {
      await c.query('SET enable_seqscan = off');   // (the fixture table is tiny: ask whether an index CAN serve each lookup)
      const stats = async () => {
        await c.query('SELECT pg_stat_force_next_flush()');
        await c.query('SELECT pg_stat_clear_snapshot()');
        const r = (await c.query(`SELECT (SELECT seq_scan FROM pg_stat_user_tables WHERE relname = 'intercompany_transactions') AS seq,
                                         (SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 'uq_ic_transactions_first_journal') AS first,
                                         (SELECT idx_scan FROM pg_stat_user_indexes WHERE indexrelname = 'idx_ic_transactions_target_journal') AS target`)).rows[0];
        return { seq: Number(r.seq), first: Number(r.first), target: Number(r.target) };
      };
      const a = await stats();
      for (let i = 0; i < 5; i++) await c.query('SELECT public.intercompany_journal_bound_elsewhere($1, $2)', [crypto.randomUUID(), crypto.randomUUID()]);
      const b = await stats();
      expect(b.first - a.first).toBeGreaterThanOrEqual(5);
      expect(b.target - a.target).toBeGreaterThanOrEqual(5);
      expect(b.seq - a.seq).toBe(0);
    } finally {
      await c.query('RESET enable_seqscan');
      c.release();
    }
  });
});
