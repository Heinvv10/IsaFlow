/**
 * NUMRACE round 2 (brk-numrace L2): a named reversal date does not date a late-claim companion's reversal.
 *
 * reverseJournalEntry reverses a late-claim original's companion with NO date (journalEntryPostingService), so the
 * companion's contra is dated on the companion (or today), whatever the run named. Round 1 predicted only the named
 * year: reverse_allocations with reversal_date 2026-03-01 over an October-2025 allocation whose input VAT was claimed
 * late (companion 2025-11-01) took 2026 for the original's contra and then 2025 for the companion's — against an
 * ascending peer, a deadlock. gl/journalReversalYears now adds the companion's years even when a date is named.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { reverseAllocationsTool } from '@/lib/mcp/tools/writeBankReverseRange';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { clearSystemAccountCache } from '@/modules/accounting/services/gl/systemAccountResolver';
import { assertLocalFixtureDbUrl } from './fixtureDbGuard';
import { dropFixture, inTx } from './helpers/l1FifoFixture';
import { lockPeriod } from './helpers/vatLateClaimFixture';
import { ascendingPeerVs, dropCrossYear, line, seedCrossYear, toolCtx, type CrossYear } from './helpers/numraceCrossYear';

const DATABASE_URL = process.env.DATABASE_URL;
const made: CrossYear[] = [];

describe.skipIf(!DATABASE_URL)('NUMRACE r2: a late-claim companion reversal is dated by its own rule', () => {
  afterAll(async () => { for (const c of made) { await dropCrossYear(c); await dropFixture(c.fx); } }, 60000);

  it('reverse_allocations with reversal_date 2026-03-01 over a late-claimed Oct-2025 line vs an ascending peer', async () => {
    assertLocalFixtureDbUrl('DATABASE_URL', DATABASE_URL, ['isaflow_test', 'isaflow_schema_fixture']);
    const c = await seedCrossYear('NUMRACE-LC', DATABASE_URL!);
    made.push(c);
    await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
        normal_balance, is_active, is_system_account)
      VALUES (${c.fx.companyId}::UUID, '1145', ${`Input VAT - late claims ${c.fx.tag}`}, 'asset',
        'vat_input_late_claim', 'debit', true, true)`;
    clearSystemAccountCache(c.fx.companyId);
    const bt = await line(c, '55555555', '2025-10-15', 'NRLC late');
    await sql`UPDATE bank_transactions SET amount = -115 WHERE id = ${bt}::UUID`;
    await lockPeriod(c.fx, '2025-09-01', '2025-10-31');
    await inTx(c.fx, () => allocateTransaction(c.fx.companyId, bt, c.expense, c.fx.userId, 'NRLC', 'account',
      undefined, 'standard', undefined, undefined, undefined, undefined, { allowLateInputClaim: true }));
    const companion = (await sql`SELECT entry_date::text AS d FROM gl_journal_entries
      WHERE company_id = ${c.fx.companyId}::UUID AND late_claim_of_id IS NOT NULL`) as { d: string }[];
    expect(companion.map((r) => r.d), 'the allocation claimed its input VAT late').toEqual(['2025-11-01']);

    const { rp, rr, before, after } = await ascendingPeerVs(c, () => reverseAllocationsTool.handler({
      bank_account_id: c.fx.bankAccountId, from_date: '2025-10-01', to_date: '2025-10-31',
      reversal_date: '2026-03-01', idempotency_key: `nr-lc-${c.fx.companyId}`,
    }, toolCtx(c)));
    process.stdout.write(`LC ${JSON.stringify({ rp: rp.ok ? 'ok' : rp, rr, deadlocks: { before, after } })}\n`);
    expect(rp.ok, JSON.stringify(rp)).toBe(true);
    expect(rr.ok ? JSON.parse((rr.value as { content: { text: string }[] }).content[0]!.text).reversed : rr).toBe(1);
    expect(after, 'pg_stat_database.deadlocks moved').toBe(before);
  }, 90000);
});
