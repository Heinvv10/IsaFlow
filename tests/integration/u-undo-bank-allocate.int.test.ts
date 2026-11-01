/**
 * Master plan U (M9): what the bank page's Undo depends on, against a real ledger.
 *
 *   - The list names the journal allocate returned, which the bank line drawer opens. After the reversal it names none,
 *     and a row of another company never answers.
 *   - The unwind: a supplier line allocated with `autoApply: 'fifo'`, as the page sends it, settled documents. `reverse`
 *     takes back all of it: documents open again, the payment cancelled, a contra posted, the line back at imported.
 *     Decision 4 keeps Undo on these lines only because this holds. Customer lines have no Undo: see bankTxUndo.ts.
 *
 * The toast logic itself is in tests/unit/components/bankTxUndo.test.ts; what an Undo may not overwrite is in
 * u-undo-guards.int.test.ts, and the controls in u-undo-controls.int.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { allocateTransaction, reverseReconciledTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankReconciliationService';
import { excludeTransaction, matchTransaction, unmatchTransaction } from '@/modules/accounting/services/bank/bankTxStatusMutations';
import {
  billState, dropFixture, inTx, seedBankTx, seedBill, seedFixture, seedSupplier, type Fixture,
} from './helpers/l1FifoFixture';
import { contraCount, expenseAccount, lineState, unclaimedLine } from './helpers/uUndoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const FIFO = { autoApply: 'fifo' } as const;

let fx: Fixture;
let other: Fixture;

/** The New tab's query, narrowed to one line. */
async function listed(f: Fixture, companyId: string, txId: string, date: string, amount: number): Promise<string | null | undefined> {
  const page = await getBankTransactions(companyId, {
    bankAccountId: f.bankAccountId, status: 'imported', fromDate: date, toDate: date,
    fromAmount: String(amount), toAmount: String(amount), limit: 100,
  });
  const row = page.transactions.find((t) => t.id === txId);
  return row ? row.matchedJournalEntryId ?? null : undefined;
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

  it('the list names the journal allocate returned, then none once it is reversed', async () => {
    const tx = await seedBankTx(fx, { date: '2026-03-02', amount: -123.45, description: 'ACCOUNT LINE' });
    const contra = await expenseAccount(fx);
    const posted = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));

    expect(await listed(fx, fx.companyId, tx, '2026-03-02', -123.45)).toBe(posted.journalEntryId);
    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));
    expect(await listed(fx, fx.companyId, tx, '2026-03-02', -123.45)).toBeNull();
  }, 60000);

  it('another company asking for the same line gets nothing', async () => {
    const tx = await seedBankTx(fx, { date: '2026-03-03', amount: -77, description: 'TENANT LINE' });
    expect(await listed(fx, other.companyId, tx, '2026-03-03', -77)).toBeUndefined();
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
    expect(await listed(fx, fx.companyId, tx, '2026-03-04', -250)).toBe(posted.journalEntryId);

    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));

    expect(await billState(fx, b1)).toMatchObject({ status: 'approved', amountPaid: 0, paymentMatched: false });
    expect(await billState(fx, b2)).toMatchObject({ status: 'approved', amountPaid: 0, paymentMatched: false });
    expect(await contraCount(fx, posted.journalEntryId)).toBe(1);
    expect(await lineState(fx, tx)).toEqual({ status: 'imported', matched: null });
  }, 60000);

  // The security review's finding: a toast outlives the state it was offered for, and the client's check is a read
  // with a gap before the write. The server has to refuse under the row lock.
  describe('a stale toast', () => {
    const CHANGED = 'This line has changed since you allocated it.';
    const RESTORE_CHANGED = 'This line has changed since you excluded it.';

    it('reverse names the journal it offered to undo: re-allocated since, it is refused and the new journal stands', async () => {
      const contra = await expenseAccount(fx);
      const tx = await seedBankTx(fx, { date: '2026-03-07', amount: -55, description: 'REALLOCATED LINE' });
      const first = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));
      await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));
      const second = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));

      await expect(inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId, {
        expectedJournalEntryId: first.journalEntryId,
      }))).rejects.toThrow(CHANGED);

      expect(await contraCount(fx, second.journalEntryId)).toBe(0);
      expect((await lineState(fx, tx)).status).toBe('allocated');
    }, 60000);

    it('reverse naming a line that has since been unallocated is refused and posts nothing', async () => {
      const contra = await expenseAccount(fx);
      const tx = await seedBankTx(fx, { date: '2026-03-08', amount: -56, description: 'UNALLOCATED LINE' });
      const posted = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));
      await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));

      await expect(inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId, {
        expectedJournalEntryId: posted.journalEntryId,
      }))).rejects.toThrow(CHANGED);
      expect(await contraCount(fx, posted.journalEntryId)).toBe(1);
    }, 60000);

    it('reverse naming the journal the line is on goes through', async () => {
      const contra = await expenseAccount(fx);
      const tx = await seedBankTx(fx, { date: '2026-03-09', amount: -57, description: 'CURRENT LINE' });
      const posted = await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));
      await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId, {
        expectedJournalEntryId: posted.journalEntryId,
      }));
      expect(await contraCount(fx, posted.journalEntryId)).toBe(1);
      expect(await lineState(fx, tx)).toEqual({ status: 'imported', matched: null });
    }, 60000);

    it('a restore of a line someone has since matched is refused, and the match stands', async () => {
      const line = await unclaimedLine(fx);
      const tx = await seedBankTx(fx, { date: '2026-03-10', amount: -58, description: 'MATCHED SINCE' });
      await inTx(fx, () => excludeTransaction(fx.companyId, tx, 'dup', fx.userId));
      await inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId)); // another person restores it...
      await inTx(fx, () => matchTransaction(fx.companyId, tx, line, undefined, fx.userId)); // ...and matches it

      await expect(inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId, { expectedStatus: 'excluded' })))
        .rejects.toThrow(RESTORE_CHANGED);

      expect(await lineState(fx, tx)).toEqual({ status: 'matched', matched: line });
    }, 60000);

    it('a restore of a line someone has since allocated gets the same refusal, not the allocated-row one', async () => {
      const contra = await expenseAccount(fx);
      const tx = await seedBankTx(fx, { date: '2026-03-11', amount: -59, description: 'ALLOCATED SINCE' });
      await inTx(fx, () => excludeTransaction(fx.companyId, tx, 'dup', fx.userId));
      await inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId));
      await inTx(fx, () => allocateTransaction(fx.companyId, tx, contra, fx.userId));

      await expect(inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId, { expectedStatus: 'excluded' })))
        .rejects.toThrow(RESTORE_CHANGED);
      expect((await lineState(fx, tx)).status).toBe('allocated');
    }, 60000);

    it('a restore of a line that is still excluded goes through', async () => {
      const tx = await seedBankTx(fx, { date: '2026-03-12', amount: -60, description: 'STILL EXCLUDED' });
      await inTx(fx, () => excludeTransaction(fx.companyId, tx, 'dup', fx.userId));
      await inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId, { expectedStatus: 'excluded' }));
      expect(await lineState(fx, tx)).toEqual({ status: 'imported', matched: null });
    }, 60000);

    it('unmatch with no expectation is unchanged: every other caller keeps its behaviour', async () => {
      const tx = await seedBankTx(fx, { date: '2026-03-13', amount: -61, description: 'PLAIN UNMATCH' });
      await inTx(fx, () => unmatchTransaction(fx.companyId, tx, fx.userId));
      expect(await lineState(fx, tx)).toEqual({ status: 'imported', matched: null });
    }, 60000);
  });
});
