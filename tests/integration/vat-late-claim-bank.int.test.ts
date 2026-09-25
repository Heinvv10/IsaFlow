/**
 * A PERSON's bank allocation dated in a filed VAT period claims its input VAT
 * late through the real route, and the bank screen and the allocation-mismatch
 * report still read it as a standard-rated allocation: its tax line now sits on
 * the late-claim clearing account, which both count as input VAT (decision N2).
 * The UNATTENDED rule auto-post keeps today's refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { getBankTransactions } from '@/modules/accounting/services/bank/bankTransactionQueryService';
import { findVatAllocationMismatches } from '@/modules/accounting/services/reports/vatAllocationMismatchService';
import { allocateTransaction } from '@/modules/accounting/services/bank/bankAllocationService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx, seedBankTx } from './helpers/l1FifoFixture';
import {
  NEXT, P, balanceOf, countRows, dropLateFixture, lockPeriod, seedLateFixture, vatFigures, type LateFixture,
} from './helpers/vatLateClaimFixture';
import { callRoute, dataOf, dropRouteUser, seedRouteUser } from './helpers/vatLateClaimRoutes';
import bankTransactionsAction from '../../pages/api/accounting/bank-transactions-action';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;
let token = '';

async function spend(amount: number): Promise<string> {
  const id = await seedBankTx(fx, { date: '2026-06-15', amount: -amount, description: 'Late VAT spend' });
  await sql`UPDATE bank_transactions SET suggested_vat_code = 'standard' WHERE id = ${id}::UUID`;
  return id;
}

describeIfDb('late input VAT claim: bank allocation', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    fx = await seedLateFixture('VLB', DATABASE_URL!);
    token = await seedRouteUser(fx, 'vlb');
    await lockPeriod(fx, P.start, P.end);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await dropRouteUser(fx);
    await dropLateFixture(fx);
  }, 120000);

  it('allocate through the route: 200, lateClaim in the response, VAT claimed in the next period', async () => {
    const tx = await spend(115);
    const nextBefore = await vatFigures(fx, NEXT.start, NEXT.end);
    const pBefore = await vatFigures(fx, P.start, P.end);
    const state = await callRoute(fx, token, bankTransactionsAction, {
      action: 'allocate', bankTransactionId: tx, allocationType: 'account',
      contraAccountId: fx.expenseId, vatCode: 'standard',
    });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(dataOf<{ lateClaim: unknown }>(state).lateClaim).toMatchObject({ claimDate: '2026-07-01', inputTax: 15 });
    expect((await vatFigures(fx, NEXT.start, NEXT.end)).inputTax - nextBefore.inputTax).toBeCloseTo(15, 2);
    expect({ ...(await vatFigures(fx, P.start, P.end)), postedThrough: '' }).toEqual({ ...pBefore, postedThrough: '' });
    expect(await balanceOf(fx, fx.clearingId)).toBe(0);
  });

  it('split_allocate through the route claims late too', async () => {
    const tx = await spend(230);
    const state = await callRoute(fx, token, bankTransactionsAction, {
      action: 'split_allocate', bankTransactionId: tx,
      // The route's split lines carry no VAT code: the VAT is a line on VAT Input.
      lines: [{ contraAccountId: fx.expenseId, amount: 200 }, { contraAccountId: fx.vatInputId, amount: 30 }],
    });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(dataOf<{ lateClaim: unknown }>(state).lateClaim).toMatchObject({ claimDate: '2026-07-01', inputTax: 30 });
  });

  it('the bank screen and the mismatch report still read a split allocation as standard-rated', async () => {
    const page = await inTx(fx, () => getBankTransactions(fx.companyId, { limit: 100 }));
    const allocated = page.transactions.filter((t) => t.status === 'allocated');
    expect(allocated.length).toBeGreaterThanOrEqual(2);
    for (const t of allocated) {
      expect(t.postedVatCode).toBe('standard');
      expect(t.allocatedEntityName).not.toBe('Split allocation');
    }
    const report = await inTx(fx, () => findVatAllocationMismatches(fx.companyId, { from: P.start, to: P.end }));
    expect(report.rows).toEqual([]);
  });

  it('the unattended rule auto-post path (no opt-in) is refused exactly as today, writing nothing', async () => {
    const tx = await spend(46);
    const before = await countRows(fx);
    const err = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, fx.expenseId, fx.userId, undefined, 'account', undefined, 'standard',
      undefined, undefined, undefined, undefined, { postingAgent: 'rule:test' },
    )).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect((err as Error).name).toBe('VatPeriodLockedError');
    expect(await countRows(fx)).toEqual(before);
    const [row] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID`) as Row[];
    expect(row!.status).toBe('imported');
  });

  async function lateAllocation(amount: number) {
    const tx = await spend(amount);
    const state = await callRoute(fx, token, bankTransactionsAction, {
      action: 'allocate', bankTransactionId: tx, allocationType: 'account',
      contraAccountId: fx.expenseId, vatCode: 'standard',
    });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    const d = dataOf<{ journalEntryId: string; lateClaim: { companionEntryId: string } }>(state);
    return { tx, originalId: d.journalEntryId, companionId: d.lateClaim.companionEntryId };
  }
  const reversedAt = async (id: string) => ((await sql`
    SELECT reversed_at FROM gl_journal_entries WHERE id = ${id}::UUID`) as Row[])[0]!.reversed_at;

  it('reversing a late-claimed allocation (route action=reverse) reverses the companion too', async () => {
    const nextBefore = await vatFigures(fx, NEXT.start, NEXT.end);
    const clearingBefore = await balanceOf(fx, fx.clearingId);
    const { tx, originalId, companionId } = await lateAllocation(69);
    const state = await callRoute(fx, token, bankTransactionsAction, { action: 'reverse', bankTransactionId: tx });
    expect(state.statusCode, JSON.stringify(state.body)).toBe(200);
    expect(await reversedAt(originalId)).not.toBeNull();
    expect(await reversedAt(companionId)).not.toBeNull();
    expect(await balanceOf(fx, fx.clearingId)).toBe(clearingBefore);
    expect((await vatFigures(fx, NEXT.start, NEXT.end)).inputTax).toBeCloseTo(nextBefore.inputTax, 2);
    const [row] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID`) as Row[];
    expect(row!.status).toBe('imported');
  });

  it('when the companion cannot be reversed, the bank reversal is refused (400) before its unwind writes', async () => {
    const { tx, originalId, companionId } = await lateAllocation(92);
    // Every date from the companion's to the end of the year is in a filed VAT period.
    await lockPeriod(fx, NEXT.start, NEXT.end);
    await lockPeriod(fx, '2026-09-01', '2026-12-31');
    try {
      const before = await countRows(fx);
      const state = await callRoute(fx, token, bankTransactionsAction, { action: 'reverse', bankTransactionId: tx });
      expect(state.statusCode).toBe(400);
      expect(JSON.stringify(state.body)).toMatch(/locked/);
      expect(await countRows(fx)).toEqual(before);
      expect(await reversedAt(originalId)).toBeNull();
      expect(await reversedAt(companionId)).toBeNull();
      const [row] = (await sql`SELECT status FROM bank_transactions WHERE id = ${tx}::UUID`) as Row[];
      expect(row!.status).toBe('allocated');
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID AND period_start >= ${NEXT.start}::DATE`;
    }
  });
});
