/**
 * Intercompany P2, round 9 (the round-8 breaker review):
 *  M1  a writer's OWN row naming another pair's receiver journal moves no figure: a third group member C, or the sender A, inserting a row whose
 *      target is B's bound journal is refused at INSERT (intercompany_journal_claimed); and a row planted with such a target anyway (a legacy
 *      manual row, or the hook-free path) holds nothing, because the exclusivity checks count only what the DATABASE bound
 *      (intercompany_journal_bound_elsewhere);
 *  S9  intercompany_journal_claimed answers only for journals of the caller's groups (no cross-tenant oracle);
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

describe('S9: intercompany_journal_claimed is no cross-tenant oracle', () => {
  it('a user of a tenant in no group with B asks about B\'s bound journal: false; a member of B\'s group gets the answer', async () => {
    const m = await accepted();
    await approveBill(m.bill);
    const j = (await L.groupRow()).target_journal_entry_id as string;
    const ask = () => asAppUser(pool, U.c, co.C, async (q) => (await q.query('SELECT public.intercompany_journal_claimed($1) AS c', [j])).rows[0].c as boolean);
    expect(await ask()).toBe(true);   // C is a member of G (beforeAll)
    await pool.query('DELETE FROM company_group_members WHERE group_id = $1 AND company_id = $2', [co.G, co.C]);
    try {
      expect(await ask()).toBe(false);   // C (only in H) learns nothing about B's journal
    } finally {
      await pool.query('INSERT INTO company_group_members(group_id, company_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [co.G, co.C]);
    }
  });
});

describe('M2: the exclusivity lookups use their indexes', () => {
  // The plan of the function's OWN statement (read from pg_proc, its parameters bound), on a table that looks like production's: 5000
  // unrelated rows of another group, analysed. (Index counters were not deterministic: on a database whose statistics say the tables are
  // empty, the planner may take either of two one-page index scans; the plan below is what a sized table gets.)
  it('intercompany_journal_bound_elsewhere: an index scan on the first-match index and one on the target index, no sequential scan, no OR of the two', async () => {
    await pool.query(`INSERT INTO intercompany_transactions(group_id, source_company_id, target_company_id, transaction_type, amount, currency, transaction_date, description)
                      SELECT $1, $2, $2, 'management_fee', 1, 'ZAR', '2026-01-01', 'm2 filler' FROM generate_series(1, 5000)`, [co.H, co.C]);
    const c = await pool.connect();
    try {
      await c.query('ANALYZE intercompany_transactions');
      const body = (await c.query("SELECT prosrc FROM pg_proc WHERE proname = 'intercompany_journal_bound_elsewhere'")).rows[0].prosrc as string;
      await c.query(`PREPARE m2_bound(uuid, uuid) AS ${body.replace(/\bp_je\b/g, '$1').replace(/\bp_row\b/g, '$2')}`);
      const plan = (await c.query(`EXPLAIN EXECUTE m2_bound('${crypto.randomUUID()}', '${crypto.randomUUID()}')`)).rows.map((r) => r['QUERY PLAN'] as string).join('\n');
      expect(plan).toMatch(/Index (Only )?Scan using uq_ic_transactions_first_journal on intercompany_transactions/);
      expect(plan).toMatch(/Index (Only )?Scan using idx_ic_transactions_target_journal on intercompany_transactions/);
      expect(plan).not.toMatch(/Seq Scan on intercompany_transactions/);
      expect(plan).not.toMatch(/BitmapOr/);
      await c.query('DEALLOCATE m2_bound');
    } finally {
      c.release();
      await pool.query("DELETE FROM intercompany_transactions WHERE description = 'm2 filler'");
      await pool.query('ANALYZE intercompany_transactions');
    }
  });
});
