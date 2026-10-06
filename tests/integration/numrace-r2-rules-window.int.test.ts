/**
 * NUMRACE round 2 (brk-numrace L1): a rule run posts exactly the candidates it read before its first journal.
 *
 * Each auto-create rule takes its first 500 matching lines by date. The round-1 run read them up front for the
 * year lock, but then RE-read each rule in the loop: once rule 1 had posted lines inside rule 2's window, rule 2's
 * re-read reached lines past it — here 2025 lines, a year the up-front set {2024, 2026} never held — and took that
 * key after 2026's. Against a peer holding 2025 that then wants 2026, that is a deadlock. Now rule 2 walks its own
 * pre-read set (less what rule 1 posted) and never reaches 2025.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { createJournalEntry } from '@/modules/accounting/services/gl/journalEntryCrudService';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture } from './helpers/l1FifoFixture';
import { journalInput, openYear } from './helpers/jenumFixture';
import { settle, waitBlockedBy } from './helpers/numraceGate';
import { deadlocks, dropCrossYear, rules, seedCrossYear, txn, type CrossYear } from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const made: CrossYear[] = [];

async function lines(c: CrossYear, n: number, firstDate: string, description: string): Promise<void> {
  await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
    SELECT ${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, ${firstDate}::DATE + (g % 28), -1,
           ${description} || ' ' || g, 'imported'
    FROM generate_series(1, ${n}) g`;
}

describe.skipIf(!DATABASE_URL)('NUMRACE r2: a rule run posts only the candidates it read up front', () => {
  afterAll(async () => { for (const c of made) { await dropCrossYear(c); await dropFixture(c.fx); } }, 120000);

  it('rule 2 past its 500-line window (2025 lines) is not reached; an ascending peer does not deadlock it', async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    const c = await seedCrossYear('NUMRACE-RW', DATABASE_URL!);
    made.push(c);
    await openYear(c.fx, 2024);
    // seedCrossYear's rule matches 'NRRULE' (priority 1); a second rule matches every 'NRR' line (priority 2).
    await sql`INSERT INTO bank_categorisation_rules (company_id, rule_name, match_field, match_type, match_pattern,
        gl_account_id, priority, auto_create_entry, vat_code)
      VALUES (${c.fx.companyId}::UUID, 'NUMRACE wide', 'description', 'contains', 'NRR', ${c.expense}::UUID, 2, true, 'none')`;
    await lines(c, 5, '2024-01-01', 'NRRULE early');   // rule 1, inside rule 2's window
    await lines(c, 1, '2026-03-01', 'NRRULE late');    // rule 1, 2026
    await lines(c, 497, '2024-02-01', 'NRR body');     // rule 2: with the 5 above, 502 > 500
    await lines(c, 3, '2025-06-01', 'NRR beyond');     // past rule 2's first window
    const before = await deadlocks(c);
    const peer = await txn(c);
    const run = await txn(c);
    let release!: () => void, holding!: () => void;
    const go = new Promise<void>((r) => { release = r; });
    const holds = new Promise<void>((r) => { holding = r; });
    try {
      const pPeer = settle(peer.run(async () => {
        await createJournalEntry(c.fx.companyId, journalInput(c.expense, c.fx.bankAccountId, '2025-10-01', 5), c.fx.userId);
        holding();
        await go;
        return createJournalEntry(c.fx.companyId, journalInput(c.expense, c.fx.bankAccountId, '2026-10-01', 6), c.fx.userId);
      }));
      await holds;
      const pRun = settle(run.run(() => rules(c)));
      // Either the run finishes without needing 2025, or it waits on the peer for it.
      const how = await Promise.race([pRun.then(() => 'done'), waitBlockedBy(c.fx.pool, peer.pid, 240000).then(() => 'blocked')]);
      release();
      const [rp, rr] = [await pPeer, await pRun];
      await new Promise((r) => setTimeout(r, 1500));
      const after = await deadlocks(c);
      const beyond = (await sql`SELECT COUNT(*)::int AS n FROM bank_transactions WHERE company_id = ${c.fx.companyId}::UUID
        AND description LIKE 'NRR beyond%' AND matched_journal_line_id IS NOT NULL`) as { n: number }[];
      process.stdout.write(`RW ${JSON.stringify({ how, rp: rp.ok ? 'ok' : rp,
        rr: rr.ok ? { applied: rr.value.applied, locked: rr.value.autoPostSkippedLocked, truncated: rr.value.autoPostTruncatedRules } : rr,
        beyond, deadlocks: { before, after } })}\n`);
      expect(rp.ok, JSON.stringify(rp)).toBe(true);
      expect(rr.ok ? rr.value.autoPostSkippedLocked : rr).toBe(0);
      expect(beyond[0]!.n, 'the run reached lines past its pre-read window').toBe(0);
      expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
    } finally {
      release();
      await peer.abandon();
      await run.abandon();
    }
  }, 300000);
});
