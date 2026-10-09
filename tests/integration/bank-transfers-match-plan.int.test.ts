/**
 * Bank transfers (PR #670, sec-nrfa rounds 26-27): the match screen's two exclusions — lines already matched, and
 * journals held by a bank-first provisional — must not fall back to a per-candidate scan once they outgrow hash_mem.
 * A NOT IN subplan the planner cannot hash re-reads the whole list for every candidate: 7-49 s with thousands of held
 * provisionals, and no answer in 300 s past about 210k matched lines. Times are not testable; the plan shape is: with
 * work_mem at its floor and a few thousand of each, no subplan may be an unhashed NOT IN. Everything is seeded, analysed
 * and planned in one transaction that is rolled back: the rows and pg_statistic go with it, but ANALYZE writes pg_class's
 * reltuples/relpages in place (sec-nrfa round 28), so afterAll analyses both tables again to put the row counts back.
 * The plan is checked twice: with the company's rows analysed, and with them arriving after the last ANALYZE (which saw
 * only another company's statement lines, half of them matched) — the state stale statistics leave (sec-nrfa round 29).
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

/** SubPlan `n`'s block in an EXPLAIN text: the lines after its header, indented deeper than it. */
function subPlanBlock(lines: string[], n: string): string {
  const at = lines.findIndex((l) => l.trim() === `SubPlan ${n}`);
  if (at < 0) return '';
  const indent = lines[at]!.search(/\S/);
  const end = lines.findIndex((l, i) => i > at && l.search(/\S/) <= indent);
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n');
}

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
const N = 3000;
let c: DateFixture;
let o: DateFixture;

/** A draft journal of `n` + 2 lines (DR expense, then `n` + 1 CR bank 100) — never candidates (posted only), only match
 * targets. */
async function draftLegs(d: DateFixture, n: number): Promise<string> {
  const je = String((await createJournalEntry(d.fx.companyId, { entryDate: '2025-03-01', description: 'MPLN draft',
    source: 'manual', lines: [{ glAccountId: d.expense, debit: 100, credit: 0, description: 'dr' },
      { glAccountId: d.fx.bankAccountId, debit: 0, credit: 100, description: 'cr' }] } as never, d.fx.userId)).id);
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    SELECT ${d.fx.companyId}::UUID, ${je}::UUID, ${d.fx.bankAccountId}::UUID, 0, 100, 'MPLN leg ' || g
    FROM generate_series(1, ${n}) g`;
  return je;
}

/** One statement line of `d` per line of `je`, every `every`-th matched to that line, the rest unmatched. */
async function statementLines(d: DateFixture, je: string, every: number): Promise<void> {
  await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
      import_batch_id, matched_journal_line_id)
    SELECT ${d.fx.companyId}::UUID, ${d.fx.bankAccountId}::UUID, '2025-03-01', -100, 'MPLN line',
      CASE WHEN rn % ${every} = 0 THEN 'matched' ELSE 'imported' END, gen_random_uuid(),
      CASE WHEN rn % ${every} = 0 THEN id END
    FROM (SELECT jl.id, row_number() OVER (ORDER BY jl.id) AS rn FROM gl_journal_lines jl
          WHERE jl.journal_entry_id = ${je}::UUID AND jl.company_id = ${d.fx.companyId}::UUID) l`;
}

/**
 * EXPLAIN of the service's candidate query for a company with N + 2 matched journal lines (N + 1 of them bank legs) and
 * N statement lines holding a provisional journal, at work_mem's floor, in a transaction that is rolled back. `stale`:
 * the last ANALYZE saw only another company's statement lines (half matched), and this company's arrive after it.
 */
async function planOf(stale: boolean): Promise<string> {
  const client = await c.fx.pool.connect();
  await client.query('BEGIN');
  try {
    return await runOn(c.fx, client, async () => {
      const co = c.fx.companyId;
      const bank = c.fx.bankAccountId;
      const je = await draftLegs(c, N);
      if (stale) {
        await statementLines(o, await draftLegs(o, N), 2);
        await sql`ANALYZE bank_transactions`;
        await sql`ANALYZE gl_journal_lines`;
      }
      await statementLines(c, je, 1);
      await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status,
          import_batch_id, provisional_je_id)
        SELECT ${co}::UUID, ${bank}::UUID, '2025-03-01', -100, 'MPLN holder', 'imported', gen_random_uuid(), ${je}::UUID
        FROM generate_series(1, ${N})`;
      if (!stale) {
        await sql`ANALYZE bank_transactions`;
        await sql`ANALYZE gl_journal_lines`;
      }
      await sql`SET LOCAL work_mem = '64kB'`;
      await sql`SET LOCAL hash_mem_multiplier = 1`;
      captured.length = 0;
      await fetchJournalLineCandidates(co, -100, '2025-03-01', 'MPLN', bank);
      const q = captured.find((x) => x.text.includes('FROM gl_journal_lines jl'));
      expect(q, 'the candidate query was not captured').toBeDefined();
      const rows = (await sql.query(`EXPLAIN ${q!.text}`, q!.values)) as Row[];
      return rows.map((r) => String(r['QUERY PLAN'])).join('\n');
    });
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

function expectFastShape(plan: string): void {
  // The held set is a NOT IN over a CTE: it must be hashed. The matched lines are a per-line index probe — the one
  // unhashed subplan, keyed on the candidate line — and never an anti join: pulled up into one, stale stats planned
  // a nested loop over the company's whole matched set (204 s, brk-nrfa round 28); keyed on a constant company, they
  // scanned the company's statement lines per candidate (80 s, sec-nrfa round 29).
  expect(plan).toMatch(/NOT \(hashed SubPlan/);
  expect(plan).not.toMatch(/Anti Join/);
  const lines = plan.split('\n');
  const unhashed = [...plan.matchAll(/NOT \(SubPlan (\d+)\)/g)].map((m) => m[1]!);
  expect(unhashed, plan).toHaveLength(1);
  // Keyed on BOTH: the line and its company (without the company it scans the whole unique index per candidate and is
  // no longer tenant-scoped — brk-nrfa round 29b).
  const cond = subPlanBlock(lines, unhashed[0]!).split('\n').find((l) => /Index Cond:/.test(l)) ?? '';
  expect(cond, plan).toMatch(/matched_journal_line_id = jl\.id/);
  expect(cond, plan).toMatch(/company_id = jl\.company_id/);
  // The held set filters the LINE: on je the planner could pair every unheld journal with every bank leg by a join
  // filter (3-18 s, brk-nrfa round 27). The plan node owning that filter is the gl_journal_lines scan.
  const at = lines.findIndex((l) => /Filter: .*NOT \(hashed SubPlan/.test(l));
  expect(at, plan).toBeGreaterThan(-1);
  const owner = lines.slice(0, at).reverse().find((l) => /->|^\S/.test(l));
  expect(owner, plan).toMatch(/on gl_journal_lines jl/);
}

describeIfDb('the match screen\'s exclusions stay hashed past hash_mem', () => {
  beforeAll(async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    c = await seedDateFixture('MPLN', DATABASE_URL!);
    o = await seedDateFixture('MPLO', DATABASE_URL!);
  }, 60000);

  afterAll(async () => {
    for (const d of [c, o]) {
      await sql`DELETE FROM bank_transactions WHERE company_id = ${d.fx.companyId}::UUID`;
      await dropFixture(d.fx);
    }
    await sql`ANALYZE bank_transactions`;
    await sql`ANALYZE gl_journal_lines`;
  }, 60000);

  it('neither exclusion is an unhashed NOT IN or an anti join, with the company analysed', async () => {
    expectFastShape(await planOf(false));
  }, 120000);

  it('the matched-line exclusion stays a probe on the line when the company\'s rows post-date the ANALYZE', async () => {
    expectFastShape(await planOf(true));
  }, 120000);
});
