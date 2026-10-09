/**
 * Auto-match direction (register HIGH, brk-nrfa round 22), through both callers of autoMatchTransactions: the Banking
 * auto_match action and MCP perform_bank_reconciliation (auto_match on by default). Money in debits the bank account and
 * money out credits it, so a +650 deposit must take the +650 receipt's bank DEBIT leg and a -660 payment its own bank
 * CREDIT leg. The inverted rule matched -650 to the receipt, +650 to a payment, and left -660 unmatched.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { sql } from '@/lib/neon';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';
import { performBankReconciliationTool } from '@/lib/mcp/tools/writeBankReconciliation';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import { teardown, type Ctx } from './d8-r4-helpers';
import { callRoute, clearExtras, setupWithUser, type Handler } from './d10-helpers';

let c: Ctx;
let token = '';
type Row = Record<string, unknown>;

/** A posted journal: the bank leg (`bankDebit` > 0 is money in, `bankCredit` > 0 money out) against expense. */
async function bankJournal(date: string, tag: string, bankDebit: number, bankCredit: number): Promise<string> {
  const [je] = (await sql`INSERT INTO gl_journal_entries (company_id, entry_date, description, status, created_by)
    VALUES (${c.fx.companyId}::UUID, ${date}::DATE, ${`AMD ${tag}`}, 'posted', ${c.fx.userId}::UUID) RETURNING id`) as Row[];
  const [bank] = (await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${c.fx.bankAccountId}::UUID, ${bankDebit}, ${bankCredit}, ${`AMD ${tag}`})
    RETURNING id`) as Row[];
  await sql`INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description)
    VALUES (${c.fx.companyId}::UUID, ${je!.id}::UUID, ${c.acct.expense}::UUID, ${bankCredit}, ${bankDebit}, ${`AMD ${tag}`})`;
  return String(bank!.id);
}
async function statementLine(date: string, amount: number, tag: string): Promise<string> {
  const [bt] = (await sql`INSERT INTO bank_transactions (company_id, bank_account_id, transaction_date, amount, description, status)
    VALUES (${c.fx.companyId}::UUID, ${c.fx.bankAccountId}::UUID, ${date}::DATE, ${amount}, ${`AMD ${tag}`}, 'imported')
    RETURNING id`) as Row[];
  return String(bt!.id);
}
/** The N8 shape: a receipt and a payment of 650, a payment of 660; statement lines +650, -650 and -660. */
async function seedN8(date: string) {
  // The payment leg is inserted BEFORE the receipt leg: a direction-blind matcher takes the first 650 leg it reads for
  // the +650 deposit (heap order), so only the direction rule can hand the deposit the receipt.
  const payment650 = await bankJournal(date, 'payment 650', 0, 650);
  const legs = {
    receipt650: await bankJournal(date, 'receipt 650', 650, 0),
    payment650,
    payment660: await bankJournal(date, 'payment 660', 0, 660),
  };
  const lines = {
    deposit650: await statementLine(date, 650, 'deposit 650'),
    payment650: await statementLine(date, -650, 'payment 650'),
    payment660: await statementLine(date, -660, 'payment 660'),
  };
  return { legs, lines };
}
const matchedLeg = async (id: string) => ((await sql`SELECT matched_journal_line_id::TEXT AS leg
  FROM bank_transactions WHERE id = ${id}::UUID AND company_id = ${c.fx.companyId}::UUID`) as Row[])[0]?.leg ?? null;
async function expectOwnDirection(s: Awaited<ReturnType<typeof seedN8>>) {
  expect(await matchedLeg(s.lines.deposit650), '+650 deposit -> the receipt\'s bank DEBIT leg').toBe(s.legs.receipt650);
  expect(await matchedLeg(s.lines.payment650), '-650 payment -> the 650 payment\'s bank CREDIT leg').toBe(s.legs.payment650);
  expect(await matchedLeg(s.lines.payment660), '-660 payment -> its own bank CREDIT leg').toBe(s.legs.payment660);
}
// Each case starts from a clean candidate pool: earlier cases' lines leave the 'imported' set and their sessions go.
async function resetPool() {
  await sql`UPDATE bank_transactions SET status = 'excluded', reconciliation_id = NULL
    WHERE company_id = ${c.fx.companyId}::UUID AND status <> 'excluded'`;
  await sql`DELETE FROM bank_reconciliations WHERE company_id = ${c.fx.companyId}::UUID`;
}

describe.skipIf(!process.env.DATABASE_URL || !process.env.JWT_SECRET)('auto-match pairs each line with its own-direction bank leg', () => {
  beforeAll(async () => {
    assertNotProductionDb('auto-match direction');
    ({ c, token } = await setupWithUser('AMD'));
  }, 120000);
  afterAll(async () => {
    await resetPool();
    await clearExtras(c); await teardown(c);
  }, 120000);
  beforeEach(resetPool);

  it('Banking auto_match action: deposit -> receipt debit leg, payments -> their credit legs', async () => {
    const s = await seedN8('2026-05-20');
    const out = await callRoute(c, token, bankTransactionsAction as Handler,
      { action: 'auto_match', bankAccountId: c.fx.bankAccountId });
    expect(out.status, out.body).toBe(200);
    expect(JSON.parse(out.body).data).toMatchObject({ matched: 3, unmatched: 0 });
    await expectOwnDirection(s);
  }, 60000);

  it('MCP perform_bank_reconciliation (auto_match by default): the same pairing inside its session', async () => {
    const s = await seedN8('2026-06-20');
    const args = { bank_account_id: c.fx.bankAccountId, statement_date: '2026-06-30', statement_balance: 0,
      idempotency_key: randomUUID() };
    const ctx = { userId: c.fx.userId, companyId: c.fx.companyId, scopes: ['write:bank-tx'], tokenJti: null, oauthAppId: null };
    const res = await inTx(c.fx, () => performBankReconciliationTool.handler(args as never, ctx as never));
    const text = (res as { content: { text: string }[] }).content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({ auto_matched: 3, still_unmatched: 0 });
    await expectOwnDirection(s);
  }, 60000);
});
