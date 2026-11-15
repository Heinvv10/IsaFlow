/**
 * WP2 row 13 through the confidence gate (autoPostGateService.sweep), the unattended poster that hands
 * `suggested_vat_code` to allocateTransaction. A line whose suggested code is none of none / standard / zero_rated /
 * exempt is skipped with the refusal as its reason and posts nothing; its neighbour with a known code still posts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let expense = '';

async function suggest(tx: string, vatCode: string): Promise<void> {
  await sql`UPDATE bank_transactions SET suggested_gl_account_id = ${expense}::UUID, suggested_confidence = 0.99,
              suggested_strategy = 'history', suggested_vat_code = ${vatCode}
            WHERE id = ${tx}::UUID AND company_id = ${fx.companyId}::UUID`;
}
async function lineOf(tx: string): Promise<{ status: string; jl: string | null }> {
  const [r] = (await sql`SELECT status, matched_journal_line_id::TEXT AS jl FROM bank_transactions
    WHERE id = ${tx}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return { status: String(r!.status), jl: r!.jl === null ? null : String(r!.jl) };
}
async function journalCount(): Promise<number> {
  const [r] = (await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return Number(r!.n);
}

describeIfDb('WP2 row 13: the confidence gate skips a suggestion with an unknown VAT code', () => {
  beforeAll(async () => {
    fx = await seedFixture('WP2GATE', DATABASE_URL!);
    const [a] = (await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = '6000'`) as Record<string, unknown>[];
    expense = String(a!.id);
    await sql`INSERT INTO bank_auto_post_settings
                (company_id, enabled, min_confidence, amount_cap, llm_enabled, llm_min_confidence, llm_amount_cap, updated_at)
              VALUES (${fx.companyId}::UUID, true, 0.50, 0, false, 0.95, 2000, NOW())`;
  }, 60000);
  afterAll(async () => {
    await sql`UPDATE bank_transactions SET auto_post_run_id = NULL WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM categorization_decisions WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM bank_auto_post_runs WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM bank_auto_post_settings WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx);
  }, 60000);

  it('skips the unknown code with the refusal as its reason, posts nothing for it, and still posts the known one', async () => {
    const bad = await seedBankTx(fx, { date: '2026-10-12', amount: -115, description: 'gate bad vat' });
    const good = await seedBankTx(fx, { date: '2026-10-12', amount: -115, description: 'gate good vat' });
    await suggest(bad, 'STD');
    await suggest(good, 'standard');
    const before = await journalCount();

    const result = await inTx(fx, () => sweep(fx.companyId, [bad, good], 'categorization', fx.userId, fx.userId));

    expect(result.skipped).toEqual([{
      txId: bad,
      reason: 'This allocation: unknown VAT code "STD" — use one of none, standard, zero_rated, exempt. Nothing was posted.',
    }]);
    expect(result.posted).toBe(1);
    expect(await journalCount()).toBe(before + 1);
    expect(await lineOf(bad)).toEqual({ status: 'imported', jl: null });
    expect((await lineOf(good)).status).toBe('allocated');
  }, 60000);
});
