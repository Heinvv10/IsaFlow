/**
 * A CUSTOMER bank rule's auto-post records the customer document behind the
 * AR it moves (bankRuleCustomerDocument), as a supplier rule records its
 * payment. Before, the sweep credited AR with no `customer_payments` row, so the
 * subledger drifted from the control by every rule-posted receipt.
 *
 *   · money in  → a receipt on the rule's journal, applied FIFO (or left on
 *                 account under auto_apply 'none')
 *   · money out → a customer refund; one larger than the customer's credit is
 *                 SKIPPED and counted (autoPostSkippedRefundCeiling), and the
 *                 rest of the run still posts
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { applyRules } from '@/modules/accounting/services/bank/bankRulesMatchingService';
import { dropFixture, inTx, seedBankTx, seedFixture, seedInvoice, seedSupplier, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

async function rule(pattern: string, autoApply: 'fifo' | 'none' = 'fifo'): Promise<void> {
  await sql`INSERT INTO bank_categorisation_rules
              (company_id, rule_name, match_field, match_type, match_pattern, client_id, auto_create_entry, auto_apply, created_by)
            VALUES (${fx.companyId}::UUID, ${`rule ${pattern}`}, 'description', 'contains', ${pattern}, ${fx.customerId}::UUID,
                    true, ${autoApply}, ${fx.userId}::UUID)`;
}
async function receiptsFor(tx: string): Promise<{ total: number; status: string }[]> {
  return (await sql`
    SELECT cp.total_amount::float8 AS total, cp.status FROM customer_payments cp
    JOIN bank_transactions bt ON bt.company_id = cp.company_id
    JOIN gl_journal_lines bl ON bl.id = bt.matched_journal_line_id AND bl.journal_entry_id = cp.gl_journal_entry_id
    WHERE bt.id = ${tx}::UUID AND cp.company_id = ${fx.companyId}::UUID`) as { total: number; status: string }[];
}
async function invoicePaid(id: string): Promise<number> {
  const [r] = (await sql`SELECT amount_paid::float8 AS p FROM customer_invoices WHERE id = ${id}::UUID`) as { p: number }[];
  return r!.p;
}
async function lineStatus(tx: string): Promise<string> {
  const [r] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID AND company_id = ${fx.companyId}::UUID`) as Record<string, unknown>[];
  return String(r!.status);
}
async function count(table: 'gl_journal_entries' | 'customer_payments' | 'supplier_payments'): Promise<number> {
  const rows = (table === 'gl_journal_entries'
    ? await sql`SELECT COUNT(*)::int AS n FROM gl_journal_entries WHERE company_id = ${fx.companyId}::UUID`
    : table === 'customer_payments'
      ? await sql`SELECT COUNT(*)::int AS n FROM customer_payments WHERE company_id = ${fx.companyId}::UUID`
      : await sql`SELECT COUNT(*)::int AS n FROM supplier_payments WHERE company_id = ${fx.companyId}::UUID`) as { n: number }[];
  return rows[0]!.n;
}
const apply = () => inTx(fx, () => applyRules(fx.companyId, fx.bankAccountId, fx.userId));
const clearRules = () => sql`DELETE FROM bank_categorisation_rules WHERE company_id = ${fx.companyId}::UUID`;

describeIfDb('a customer bank rule records the receipt or refund behind the AR it moves', () => {
  beforeAll(async () => { fx = await seedFixture('CRULE', DATABASE_URL!); }, 60000);
  afterAll(async () => { await clearRules(); await dropFixture(fx); }, 60000);

  it('money in: a receipt on the rule\'s journal, applied FIFO to the oldest invoice', async () => {
    const inv = await seedInvoice(fx, { number: 'CR1', date: '2026-09-01', total: 300 });
    await rule('CRULEFIFO');
    const tx = await seedBankTx(fx, { date: '2026-10-01', amount: 300, description: 'CRULEFIFO deposit' });
    const result = await apply();
    expect(result.applied).toBe(1);
    expect(await receiptsFor(tx)).toEqual([{ total: 300, status: 'reconciled' }]); // fully applied
    expect(await invoicePaid(inv)).toBe(300);
    await clearRules();
  }, 60000);

  it('money in under auto_apply none: the receipt stays on account', async () => {
    const inv = await seedInvoice(fx, { number: 'CR2', date: '2026-09-02', total: 200 });
    await rule('CRULENONE', 'none');
    const tx = await seedBankTx(fx, { date: '2026-10-02', amount: 200, description: 'CRULENONE deposit' });
    await apply();
    expect(await receiptsFor(tx)).toEqual([{ total: 200, status: 'confirmed' }]);
    expect(await invoicePaid(inv)).toBe(0);
    await clearRules();
  }, 60000);

  it('money out past the customer\'s credit: skipped and counted, the run still posts the rest', async () => {
    await rule('CRULEREF');
    const refund = await seedBankTx(fx, { date: '2026-10-03', amount: -5000, description: 'CRULEREF refund' });
    const deposit = await seedBankTx(fx, { date: '2026-10-03', amount: 50, description: 'CRULEREF deposit' });
    const [journals, receipts] = [await count('gl_journal_entries'), await count('customer_payments')];
    const result = await apply();
    expect(result).toMatchObject({ autoPostSkippedRefundCeiling: 1 });
    expect(await lineStatus(refund)).toBe('imported');
    // Only the deposit wrote: one journal and one receipt. The refund wrote neither.
    expect([await count('gl_journal_entries'), await count('customer_payments')]).toEqual([journals + 1, receipts + 1]);
    expect(await lineStatus(deposit)).toBe('allocated');
    expect(await receiptsFor(deposit)).toHaveLength(1);
    await clearRules();
  }, 60000);

  it('a SUPPLIER rule refund past the supplier\'s credit is skipped and counted too, where it used to abort the run', async () => {
    const sup = await seedSupplier(fx, 'NOCREDIT');
    await sql`INSERT INTO bank_categorisation_rules
                (company_id, rule_name, match_field, match_type, match_pattern, supplier_id, auto_create_entry, created_by)
              VALUES (${fx.companyId}::UUID, 'supplier refund rule', 'description', 'contains', 'SRULEREF', ${sup}::UUID, true, ${fx.userId}::UUID)`;
    const refund = await seedBankTx(fx, { date: '2026-10-04', amount: 900, description: 'SRULEREF refund in' });
    const [journals, payments] = [await count('gl_journal_entries'), await count('supplier_payments')];
    const result = await apply();
    expect(result).toMatchObject({ autoPostSkippedRefundCeiling: 1 });
    expect(await lineStatus(refund)).toBe('imported');
    expect([await count('gl_journal_entries'), await count('supplier_payments')]).toEqual([journals, payments]);
    await clearRules();
  }, 60000);

  it('a rule whose customer is not this company\'s posts nothing (a pre-fence legacy row)', async () => {
    const other = await seedFixture('CRULEX', DATABASE_URL!);
    try {
      await sql`INSERT INTO bank_categorisation_rules
                  (company_id, rule_name, match_field, match_type, match_pattern, client_id, auto_create_entry, created_by)
                VALUES (${fx.companyId}::UUID, 'foreign customer rule', 'description', 'contains', 'CRULEFOREIGN', ${other.customerId}::UUID, true, ${fx.userId}::UUID)`;
      const tx = await seedBankTx(fx, { date: '2026-10-05', amount: 120, description: 'CRULEFOREIGN deposit' });
      const [journals, receipts] = [await count('gl_journal_entries'), await count('customer_payments')];
      await apply();
      expect(await lineStatus(tx)).toBe('imported');
      expect([await count('gl_journal_entries'), await count('customer_payments')]).toEqual([journals, receipts]);
    } finally {
      await clearRules();
      await dropFixture(other);
    }
  }, 60000);
});
