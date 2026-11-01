/**
 * Master plan U (M9): what the bank page's Undo depends on, against a real ledger.
 *
 *   - The re-read: the list, asked for exactly what bankTxUndo asks (this bank account, the New tab's statuses, the
 *     line's date, its amount), finds the line and names the journal allocate returned. After the reversal it names
 *     none, and a row of another company never answers.
 *   - The unwind: a customer or supplier line allocated with `autoApply: 'fifo'`, as the page sends it, settled
 *     documents. `reverse` takes back all of it: documents open again, the payment cancelled, a contra posted, the
 *     line back at imported. Decision 4 keeps Undo on these lines only because this holds.
 *
 * The toast logic itself is in tests/unit/components/bankTxUndo.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankReconciliationService';
import { excludeTransaction, matchTransaction, unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import {
  billState, dropFixture, inTx, seedBankTx, seedBill, seedFixture, seedInvoice, seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const FIFO = { autoApply: 'fifo' } as const;

let fx: Fixture;
let other: Fixture;

/** bankTxUndo.currentJournalOf's query. */
async function reread(f: Fixture, companyId: string, txId: string, date: string, amount: number): Promise<string | null | undefined> {
  const page = await getBankTransactions(companyId, {
    bankAccountId: f.bankAccountId, status: 'imported', fromDate: date, toDate: date,
    fromAmount: String(amount), toAmount: String(amount), limit: 100,
  });
  const row = page.transactions.find((t) => t.id === txId);
  return row ? row.matchedJournalEntryId ?? null : undefined;
}

async function contraCount(journalEntryId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM gl_journal_entries
    WHERE company_id = ${fx.companyId}::UUID AND reversal_of_id = ${journalEntryId}::UUID`) as { n: number }[];
  return rows[0]!.n;
}

async function lineState(txId: string): Promise<{ status: string; matched: string | null }> {
  const rows = (await sql`
    SELECT status, matched_journal_line_id::TEXT AS matched FROM bank_transactions
    WHERE id = ${txId}::UUID AND company_id = ${fx.companyId}::UUID`) as { status: string; matched: string | null }[];
  return rows[0]!;
}

async function invoiceState(id: string): Promise<{ status: string; paid: number }> {
  const rows = (await sql`
    SELECT status, amount_paid::float8 AS paid FROM customer_invoices
    WHERE id = ${id}::UUID AND company_id = ${fx.companyId}::UUID`) as { status: string; paid: number }[];
  return rows[0]!;
}

async function receiptStatus(journalEntryId: string): Promise<string> {
  const rows = (await sql`
    SELECT status FROM customer_payments
    WHERE company_id = ${fx.companyId}::UUID AND gl_journal_entry_id = ${journalEntryId}::UUID`) as { status: string }[];
  return rows[0]!.status;
}

async function expenseAccount(): Promise<string> {
  const found = (await sql`
    SELECT id FROM gl_accounts WHERE company_id = ${fx.companyId}::UUID AND account_code = ${'U-EXP'}`) as { id: string }[];
  if (found[0]) return found[0].id;
  return ((await sql`
    INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, normal_balance)
    VALUES (${fx.companyId}::UUID, ${'U-EXP'}, ${'Undo expense'}, 'expense', 'debit') RETURNING id`) as { id: string }[])[0]!.id;
}

/** A posted journal line no bank line claims: the contra of an allocation on a line of its own. */
async function unclaimedLine(): Promise<string> {
  const contra = await expenseAccount();
  const tx = await seedBankTx(fx, { date: '2026-03-06', amount: -10, description: 'SOURCE LINE' });
  const { journalEntryId } = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));
  const rows = (await sql`
    SELECT id FROM gl_journal_lines
    WHERE journal_entry_id = ${journalEntryId}::UUID AND company_id = ${fx.companyId}::UUID
      AND gl_account_id = ${contra}::UUID`) as { id: string }[];
  return rows[0]!.id;
}

describeIfDb('U: Undo after a single-row allocate', () => {
  beforeAll(async () => {
    fx = await seedFixture('UU', DATABASE_URL!);
    other = await seedFixture('UX', DATABASE_URL!);
  }, 60000);

  afterAll(async () => {
    await dropFixture(fx);
    await dropFixture(other);
  }, 60000);

  it('the re-read names the journal allocate returned, then none once it is reversed', async () => {
    const tx = await seedBankTx(fx, { date: '2026-03-02', amount: -123.45, description: 'ACCOUNT LINE' });
    const contra = await expenseAccount();
    const posted = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));

    expect(await reread(fx, fx.companyId, tx, '2026-03-02', -123.45)).toBe(posted.journalEntryId);
    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));
    expect(await reread(fx, fx.companyId, tx, '2026-03-02', -123.45)).toBeNull();
  }, 60000);

  it('another company asking for the same line gets nothing', async () => {
    const tx = await seedBankTx(fx, { date: '2026-03-03', amount: -77, description: 'TENANT LINE' });
    expect(await reread(fx, other.companyId, tx, '2026-03-03', -77)).toBeUndefined();
  }, 60000);

  it('a supplier line: FIFO bills reopen, the payment is cancelled, a contra posts, the line is imported', async () => {
    const sup = await seedSupplier(fx, 'UA');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'U1', date: '2026-02-01', total: 100 });
    const b2 = await seedBill(fx, { supplierId: sup, number: 'U2', date: '2026-02-02', total: 200 });
    const tx = await seedBankTx(fx, { date: '2026-03-04', amount: -250, description: 'SUPPLIER LINE' });
    const posted = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
      undefined, undefined, undefined, undefined, undefined, FIFO,
    ));
    expect(await billState(fx, b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await reread(fx, fx.companyId, tx, '2026-03-04', -250)).toBe(posted.journalEntryId);

    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));

    expect(await billState(fx, b1)).toMatchObject({ status: 'approved', amountPaid: 0, paymentMatched: false });
    expect(await billState(fx, b2)).toMatchObject({ status: 'approved', amountPaid: 0, paymentMatched: false });
    expect(await contraCount(posted.journalEntryId)).toBe(1);
    expect(await lineState(tx)).toEqual({ status: 'imported', matched: null });
  }, 60000);

  it('a customer line: FIFO invoices reopen, the receipt is cancelled, a contra posts, the line is imported', async () => {
    const i1 = await seedInvoice(fx, { number: 'UI1', date: '2026-02-01', total: 100 });
    const i2 = await seedInvoice(fx, { number: 'UI2', date: '2026-02-02', total: 200 });
    const tx = await seedBankTx(fx, { date: '2026-03-05', amount: 250, description: 'CUSTOMER LINE' });
    const posted = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'customer', fx.customerId,
      undefined, undefined, undefined, undefined, undefined, FIFO,
    ));
    expect((await invoiceState(i1)).paid).toBe(100);
    expect((await invoiceState(i2)).paid).toBe(150);

    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));

    // 'approved', not 'sent': once a payment has moved an invoice to paid or partially_paid, recomputeInvoiceStatus
    // cannot tell what it was before. The money is exact; the label is that rule's, and reverse is not U's to change.
    expect(await invoiceState(i1)).toEqual({ status: 'approved', paid: 0 });
    expect(await invoiceState(i2)).toEqual({ status: 'approved', paid: 0 });
    expect(await receiptStatus(posted.journalEntryId)).toBe('cancelled');
    expect(await contraCount(posted.journalEntryId)).toBe(1);
    expect(await lineState(tx)).toEqual({ status: 'imported', matched: null });
  }, 60000);

  // The security review's finding: a toast outlives the state it was offered for, and the client's check is a read
  // with a gap before the write. The server has to refuse under the row lock.
  describe('a stale toast', () => {
    const CHANGED = 'This line has changed since you allocated it.';

    it('reverse names the journal it offered to undo: re-allocated since, it is refused and the new journal stands', async () => {
      const contra = await expenseAccount();
      const tx = await seedBankTx(fx, { date: '2026-03-07', amount: -55, description: 'REALLOCATED LINE' });
      const first = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));
      await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));
      const second = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));

      await expect(inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId, {
        expectedJournalEntryId: first.journalEntryId,
      }))).rejects.toThrow(CHANGED);

      expect(await contraCount(second.journalEntryId)).toBe(0);
      expect((await lineState(tx)).status).toBe('allocated');
    }, 60000);

    it('reverse naming a line that has since been unallocated is refused and posts nothing', async () => {
      const contra = await expenseAccount();
      const tx = await seedBankTx(fx, { date: '2026-03-08', amount: -56, description: 'UNALLOCATED LINE' });
      const posted = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));
      await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));

      await expect(inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId, {
        expectedJournalEntryId: posted.journalEntryId,
      }))).rejects.toThrow(CHANGED);
      expect(await contraCount(posted.journalEntryId)).toBe(1);
    }, 60000);

    it('reverse naming the journal the line is on goes through', async () => {
      const contra = await expenseAccount();
      const tx = await seedBankTx(fx, { date: '2026-03-09', amount: -57, description: 'CURRENT LINE' });
      const posted = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));
      await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId, {
        expectedJournalEntryId: posted.journalEntryId,
      }));
      expect(await contraCount(posted.journalEntryId)).toBe(1);
      expect(await lineState(tx)).toEqual({ status: 'imported', matched: null });
    }, 60000);

    it('a restore of a line someone has since matched is refused, and the match stands', async () => {
      const line = await unclaimedLine();
      const tx = await seedBankTx(fx, { date: '2026-03-10', amount: -58, description: 'MATCHED SINCE' });
      await inTx(fx, () => excludeTransaction(fx.companyId, tx, 'dup', fx.userId));
      await inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId)); // another person restores it...
      await inTx(fx, () => matchTransaction(fx.companyId, tx, line, undefined, fx.userId)); // ...and matches it

      await expect(inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId, { expectedStatus: 'excluded' })))
        .rejects.toThrow(CHANGED);

      expect(await lineState(tx)).toEqual({ status: 'matched', matched: line });
    }, 60000);

    it('a restore of a line someone has since allocated gets the same refusal, not the allocated-row one', async () => {
      const contra = await expenseAccount();
      const tx = await seedBankTx(fx, { date: '2026-03-11', amount: -59, description: 'ALLOCATED SINCE' });
      await inTx(fx, () => excludeTransaction(fx.companyId, tx, 'dup', fx.userId));
      await inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId));
      await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));

      await expect(inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId, { expectedStatus: 'excluded' })))
        .rejects.toThrow(CHANGED);
      expect((await lineState(tx)).status).toBe('allocated');
    }, 60000);

    it('a restore of a line that is still excluded goes through', async () => {
      const tx = await seedBankTx(fx, { date: '2026-03-12', amount: -60, description: 'STILL EXCLUDED' });
      await inTx(fx, () => excludeTransaction(fx.companyId, tx, 'dup', fx.userId));
      await inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId, { expectedStatus: 'excluded' }));
      expect(await lineState(tx)).toEqual({ status: 'imported', matched: null });
    }, 60000);

    it('unmatch with no expectation is unchanged: every other caller keeps its behaviour', async () => {
      const tx = await seedBankTx(fx, { date: '2026-03-13', amount: -61, description: 'PLAIN UNMATCH' });
      await inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId));
      expect(await lineState(tx)).toEqual({ status: 'imported', matched: null });
    }, 60000);
  });
});
