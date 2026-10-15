/**
 * A whole bank line allocated to an ACCOUNT may not be AP or AR control.
 *
 * Posted there, the control moves with no payment, receipt or refund document
 * behind it, so the subledger drifts from the control by the line's amount.
 * Split lines have been refused since PR #711. This closes the same door on
 * `allocateTransaction`'s account arm, which the bank screen, Spend/Receive
 * Money, the MCP allocate tool and the auto-post sweep all reach. The remedy
 * is to allocate the line to the supplier or customer, which records the
 * document; that keeps working.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import { createRule, toggleRule, updateRule } from '@/modules/accounting/services/bank/bankRulesService';
import { dropFixture, inTx, seedBankTx, seedFixture, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

async function accountByCode(code: string): Promise<string> {
  const [r] = (await sql`SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = ${code}`) as Record<string, unknown>[];
  return String(r!.id);
}
async function journalCount(): Promise<number> {
  const [r] = (await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return Number(r!.n);
}
async function lineStatus(tx: string): Promise<string> {
  const [r] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return String(r!.status);
}

describeIfDb('a whole-line account allocation may not post to AP/AR control', () => {
  beforeAll(async () => { fx = await seedFixture('CTRL', DATABASE_URL!); }, 60000);
  afterAll(async () => { await dropFixture(fx); }, 60000);

  it.each([
    ['money out onto AP control', -500, '2100', /accounts payable control account: name the supplier/],
    ['money in onto AR control', 500, '1100', /accounts receivable control account: name the customer/],
  ])('refuses %s before anything is written', async (_what, amount, code, message) => {
    const tx = await seedBankTx(fx, { date: '2026-10-01', amount, description: `ctrl ${code}` });
    const before = await journalCount();
    const contra = await accountByCode(code);
    await expect(inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId, undefined, 'account', undefined)))
      .rejects.toThrow(message);
    expect(await journalCount()).toBe(before);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('refuses a supplier allocation that names no supplier and falls through to AP control', async () => {
    const tx = await seedBankTx(fx, { date: '2026-10-03', amount: -400, description: 'no contact' });
    const before = await journalCount();
    await expect(inTx(fx, async () => allocateTransaction(fx.companyId, tx, await accountByCode('2100'), fx.userId, undefined, 'supplier', undefined)))
      .rejects.toThrow(/accounts payable control account: name the supplier/);
    expect(await journalCount()).toBe(before);
  }, 60000);

  it('refuses a customer allocation that names no customer and falls through to AR control', async () => {
    const tx = await seedBankTx(fx, { date: '2026-10-03', amount: 400, description: 'no customer' });
    await expect(inTx(fx, async () => allocateTransaction(fx.companyId, tx, await accountByCode('1100'), fx.userId, undefined, 'customer', undefined)))
      .rejects.toThrow(/accounts receivable control account: name the customer/);
    expect(await lineStatus(tx)).toBe('imported');
  }, 60000);

  it('refuses a bank rule that posts to AP control, and the sweep skips (counts) one that already does', async () => {
    const ap = await accountByCode('2100');
    await expect(inTx(fx, () => createRule(fx.companyId, {
      ruleName: 'AP rule', matchField: 'description', matchType: 'contains', matchPattern: 'CTRLRULE', glAccountId: ap, autoCreateEntry: true,
    } as never, fx.userId))).rejects.toThrow(/^Rule "AP rule" posts to the accounts payable control account: .*set the rule's supplier/);

    // A rule written before the guard existed (straight INSERT): the sweep must not post through it.
    await sql`INSERT INTO bank_categorisation_rules (company_id, rule_name, match_field, match_type, match_pattern, gl_account_id, auto_create_entry, created_by)
              VALUES (${fx.companyId}::UUID, 'legacy AP rule', 'description', 'contains', 'CTRLRULE', ${ap}::UUID, true, ${fx.userId}::UUID)`;
    const tx = await seedBankTx(fx, { date: '2026-10-04', amount: -250, description: 'CTRLRULE debit' });
    const before = await journalCount();
    const result = await inTx(fx, () => applyRules(fx.companyId, fx.bankAccountId, fx.userId));
    expect(result).toMatchObject({ autoPostSkippedControlAccount: 1 });
    expect(await journalCount()).toBe(before);
    expect(await lineStatus(tx)).toBe('imported');
    // Re-enabling that legacy rule is refused; disabling it is not.
    const [legacy] = (await sql`SELECT id FROM bank_categorisation_rules WHERE company_id = ${fx.companyId}::UUID AND rule_name = 'legacy AP rule'`) as Record<string, unknown>[];
    await inTx(fx, () => toggleRule(fx.companyId, String(legacy!.id), false, fx.userId));
    await expect(inTx(fx, () => toggleRule(fx.companyId, String(legacy!.id), true, fx.userId)))
      .rejects.toThrow(/^Rule "legacy AP rule" posts to the accounts payable control account/);
    await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${fx.companyId}::UUID`;
  }, 60000);

  it('refuses repointing an account rule at AP control; a supplier rule may carry that account', async () => {
    const ap = await accountByCode('2100');
    const base = { matchField: 'description', matchType: 'contains', autoCreateEntry: false };
    const expense = await accountByCode('6000');
    const rule = await inTx(fx, () => createRule(fx.companyId, { ...base, ruleName: 'expense rule', matchPattern: 'UPD1', glAccountId: expense } as never, fx.userId));
    await expect(inTx(fx, () => updateRule(fx.companyId, String((rule as { id: string }).id), { glAccountId: ap }, fx.userId)))
      .rejects.toThrow(/^Rule "expense rule" posts to the accounts payable control account/);
    const sup = await inTx(fx, () => createRule(fx.companyId, { ...base, ruleName: 'supplier rule', matchPattern: 'UPD2', supplierId: fx.supplierId } as never, fx.userId));
    await inTx(fx, () => updateRule(fx.companyId, String((sup as { id: string }).id), { glAccountId: ap }, fx.userId));
    await sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${fx.companyId}::UUID`;
  }, 60000);

  it('still allocates to an ordinary account, and to the supplier (the remedy)', async () => {
    const out = await seedBankTx(fx, { date: '2026-10-02', amount: -300, description: 'expense' });
    const expense = await accountByCode('6000');
    await inTx(fx, () => allocateTransaction(fx.companyId, out, expense, fx.userId, undefined, 'account', undefined));
    expect(await lineStatus(out)).toBe('allocated');

    const pay = await seedBankTx(fx, { date: '2026-10-02', amount: -200, description: 'supplier' });
    await inTx(fx, () => allocateTransaction(fx.companyId, pay, null, fx.userId, undefined, 'supplier', fx.supplierId));
    expect(await lineStatus(pay)).toBe('allocated');
  }, 60000);
});
