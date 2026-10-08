/**
 * Bank transfers (PR #670, sec-nrfa rounds 26-27): the match screen's two exclusions — lines already matched, and
 * journals held by a bank-first provisional — must not fall back to a per-candidate scan once they outgrow hash_mem.
 * A NOT IN subplan the planner cannot hash re-reads the whole list for every candidate: 7-49 s with thousands of held
 * provisionals, and no answer in 300 s past about 210k matched lines. Times are not testable; the plan shape is: with
 * work_mem at its floor and a few thousand of each, no subplan may be an unhashed NOT IN. Everything is seeded, analysed
 * and planned in one transaction that is rolled back, statistics included.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, runOn } from './helpers/l1FifoFixture';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { fetchJournalLineCandidates } from '@/modules/accounting/services/bank/bankMatchDbQueries';
import { seedDateFixture, type DateFixture } from './helpers/numraceDateFixture';

/** The text and parameters of every query the service sends, as pg receives them. */
const captured = vi.hoisted(() => [] as Array<{ text: string; values: unknown[] }>);
vi.mock('@/lib/neon', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/neon')>();
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const q = original.sql(strings, ...values);
    captured.push({ text: q.text, values: q.values });
    return q;
  };
  Object.assign(sql, { transaction: original.sql.transaction, unsafe: original.sql.unsafe, query: original.sql.query });
  return { ...original, sql, default: sql };
});

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
const N = 3000;
let c: DateFixture;

describeIfDb('the match screen\'s exclusions stay hashed past hash_mem', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('MPLN', DATABASE_URL!);
  }, 60000);

  afterAll(async () => {
    await sql`DELETE FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID`;
    await dropFixture(c.fx);
  }, 60000);

  it('neither the matched-line nor the held-journal exclusion is an unhashed NOT IN', async () => {
    const client = await c.fx.pool.connect();
    await client.query('BEGIN');
    try {
      const plan = await runOn(c.fx, client, async () => {
        const co = c.fx.companyId;
        const bank = c.fx.bankAccountId;
        // A draft journal: its lines are never candidates (posted only), they only give the statement lines a target.
        const je = String((await createJournalEntry(co, { entryDate: '2025-03-01', description: 'MPLN draft',
          source: 'manual', lines: [{ glAccountId: c.expense, debit: 100, credit: 0, description: 'dr' },
            { glAccountId: bank, debit: 0, credit: 100, description: 'cr' }] } as never, c.fx.userId)).id);
        // N bank legs, each matched by its own statement line; N statement lines holding a provisional journal.
        await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
          SELECT ${co}::UUID, ${je}::UUID, ${bank}::UUID, 0, 100, 'MPLN leg ' || g FROM generate_series(1, ${N}) g`;
        await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
            import_batch_id, matched_journal_line_id)
          SELECT ${co}::UUID, ${bank}::UUID, '2025-03-01', -100, 'MPLN matched', 'matched', gen_random_uuid(), jl.id
          FROM gl_journal_lines jl WHERE jl.journal_entry_id = ${je}::UUID AND jl.company_id = ${co}::UUID`;
        await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
            import_batch_id, provisional_je_id)
          SELECT ${co}::UUID, ${bank}::UUID, '2025-03-01', -100, 'MPLN holder', 'imported', gen_random_uuid(), ${je}::UUID
          FROM generate_series(1, ${N})`;
        await sql`ANALYZE bank_transactions`;
        await sql`SET LOCAL work_mem = '64kB'`;
        await sql`SET LOCAL hash_mem_multiplier = 1`;
        captured.length = 0;
        await fetchJournalLineCandidates(co, -100, '2025-03-01', 'MPLN', bank);
        const q = captured.find((x) => x.text.includes('FROM gl_journal_lines jl'));
        expect(q, 'the candidate query was not captured').toBeDefined();
        const rows = (await sql.query(`EXPLAIN ${q!.text}`, q!.values)) as Row[];
        return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
      });
      // The held set is a NOT IN over a CTE: it must be hashed. The matched lines are an anti join (no subplan at all).
      expect(plan).toMatch(/NOT \(hashed SubPlan/);
      expect(plan).not.toMatch(/NOT \(SubPlan/);
      expect(plan).toMatch(/Anti Join/);
      // The held set filters the LINE: on je the planner could pair every unheld journal with every bank leg by a join
      // filter (3-18 s, brk-nrfa round 27). The plan node owning that filter is the gl_journal_lines scan.
      const lines = plan.split('\n');
      const at = lines.findIndex((l) => /Filter: .*NOT \(hashed SubPlan/.test(l));
      const owner = lines.slice(0, at).reverse().find((l) => /->|^\S/.test(l));
      expect(owner, plan).toMatch(/on gl_journal_lines jl/);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }, 120000);
});
