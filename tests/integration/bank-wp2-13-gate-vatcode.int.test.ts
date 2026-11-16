/**
 * WP2 row 13 through the confidence gate (autoPostGateService.sweep), the unattended poster that hands
 * `suggested_vat_code` to allocateTransaction. A line whose suggested code is none of none / standard / zero_rated /
 * exempt is skipped with the refusal as its reason and posts nothing; its neighbour with a known code still posts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { sweep } from '@/modules/accounting/services/bank/autoPostGateService';
import { postProvisional } from '@/modules/accounting/services/capture/provisionalPostingService';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;
let expense = '';
const REASON = 'This allocation: unknown VAT code "STD" — use one of none, standard, zero_rated, exempt. Nothing was posted.';

async function account(code: string, name: string, type: string, subtype: string, normal: string): Promise<string> {
  return String(((await sql`INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
      normal_balance, is_active, is_system_account)
    VALUES (${fx.companyId}::UUID, ${code}, ${`${name} ${fx.tag}`}, ${type}, ${subtype}, ${normal}, true, false)
    RETURNING id`) as Record<string, unknown>[])[0]!.id);
}
async function suggest(tx: string, vatCode: string, target = expense): Promise<void> {
  await sql`UPDATE bank_transactions SET suggested_gl_account_id = ${target}::UUID, suggested_confidence = 0.99,
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
    await sql`DELETE FROM supplier_coding_history WHERE company_id = ${fx.companyId}::UUID`;
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
  // Round 2 (breaker, MEDIUM): the gate runs the VAT guards BEFORE allocateTransaction, and on a non-supply account
  // (salaries) or a bank contra they rewrote the unknown 'STD' to 'none' — so it posted, counted as coerced. The
  // allow-list now runs first, inside resolveRuleVatCode, so no guard can launder an unknown code.
  it.each([
    ['a salaries account (the non-supply guard)', () => account('6100', 'Salaries and Wages', 'expense', 'default_expense', 'debit')],
    ['a bank contra (the bank-contra guard)', () => account('1010', 'Second Bank', 'asset', 'bank', 'debit')],
  ])('skips an unknown code suggested onto %s, posting nothing', async (_what, makeTarget) => {
    const target = await makeTarget();
    const bad = await seedBankTx(fx, { date: '2026-10-13', amount: -115, description: 'gate coerced vat' });
    await suggest(bad, 'STD', target);
    const before = await journalCount();

    const result = await inTx(fx, () => sweep(fx.companyId, [bad], 'categorization', fx.userId, fx.userId));

    expect(result).toMatchObject({ posted: 0, skipped: [{ txId: bad, reason: REASON }] });
    expect(await journalCount()).toBe(before);
    expect(await lineOf(bad)).toEqual({ status: 'imported', jl: null });
  }, 60000);

  // Round 2 (breaker, LOW): the predictor took the MODE of the history's codes, garbage included, so a supplier
  // whose history is mostly a VAT NUMBER (what capture records on dev) was skipped forever. The mode is now taken
  // over the valid codes only.
  it('the provisional poster codes from the valid history codes, ignoring a VAT number recorded as a code', async () => {
    for (const code of ['4240294944', '4240294944', '4240294944', 'standard']) {
      await sql`INSERT INTO supplier_coding_history (company_id, supplier_id, gl_account_id, vat_code, posted_by)
                VALUES (${fx.companyId}::UUID, ${fx.supplierId}::UUID, ${expense}::UUID, ${code}, ${fx.userId})`;
    }
    const tx = await seedBankTx(fx, { date: '2026-10-14', amount: -115, description: 'SUP' }); // "SUP <tag>": the supplier
    const out = await inTx(fx, () => postProvisional(fx.companyId, tx, fx.userId));
    expect(out.skipped, String(out.skipped)).toBeUndefined();
    expect(out.prediction.vatCode).toBe('standard');
    const lines = (await sql`SELECT a.account_code, jl.debit::float8 AS dr, jl.vat_type FROM gl_journal_lines jl
      JOIN gl_accounts a ON a.id = jl.gl_account_id WHERE jl.journal_entry_id = ${out.journalEntryId}::UUID AND jl.debit > 0
      ORDER BY a.account_code`) as Record<string, unknown>[];
    expect(lines.map((l) => `${String(l.account_code)}:${Number(l.dr).toFixed(2)}:${String(l.vat_type)}`))
      .toEqual(['1140:15.00:standard', '6000:100.00:standard']);
  }, 60000);
});
