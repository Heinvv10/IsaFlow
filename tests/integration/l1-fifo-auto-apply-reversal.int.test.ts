/**
 * L1 — undoing a FIFO allocation, batching several of them, and two of them
 * racing for one bill.
 *
 * The forward behaviour is in l1-fifo-auto-apply.int.test.ts. These are the
 * three ways a default that APPLIES can go wrong where a default that applied
 * nothing could not: a reversal that leaves the bill settled, a batch whose
 * lines each claim the same bill, and two requests that both read the same open
 * balance.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import {
  allocateTransaction,
  reverseReconciledTransaction,
} from '@/modules/accounting/services/bank/bankAllocationService';
import { recordSupplierBankPayment } from '@/modules/accounting/services/ap/supplierAutoAllocate';
import {
  billState, dropFixture, inTx, runOn, seedBankTx, seedBill, seedFixture, seedSupplier,
  type Fixture,
} from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;

let fx: Fixture;

async function paymentStatus(journalEntryId: string): Promise<string> {
  const rows = (await sql`
    SELECT status FROM supplier_payments
    WHERE company_id = ${fx.companyId}::UUID
      AND gl_journal_entry_id = ${journalEntryId}::UUID`) as Record<string, unknown>[];
  return String(rows[0]!.status);
}

async function allocationCount(journalEntryId: string): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::INT AS n FROM payment_allocations pa
    JOIN supplier_payments sp ON sp.id = pa.payment_id
    WHERE sp.company_id = ${fx.companyId}::UUID
      AND sp.gl_journal_entry_id = ${journalEntryId}::UUID`) as Record<string, unknown>[];
  return Number(rows[0]!.n);
}

describeIfDb('L1 — reversing, batching and racing a FIFO allocation', () => {
  beforeAll(async () => {
    fx = await seedFixture('L1R', DATABASE_URL!);
  }, 60000);

  afterAll(async () => {
    await dropFixture(fx);
  }, 60000);

  it('puts every bill back exactly as it was, and cancels the payment', async () => {
    // A supplier of this test's own — see the note in the forward file.
    const sup = await seedSupplier(fx, 'R1');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'R1', date: '2026-02-01', total: 100 });
    const b2 = await seedBill(fx, { supplierId: sup, number: 'R2', date: '2026-02-02', total: 200 });
    const tx = await seedBankTx(fx, { date: '2026-03-01', amount: -250, description: 'EFT-REV' });

    const posted = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
    ));
    expect(await billState(fx, b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await billState(fx, b2)).toMatchObject({ status: 'partially_paid', amountPaid: 150 });

    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));

    // Reversing the journal without this would leave both bills reading as
    // settled while the credit went back onto the control account — the
    // subledger-to-control gap this programme exists to find.
    expect(await billState(fx, b1)).toMatchObject({
      status: 'approved', amountPaid: 0, paymentMatched: false,
    });
    expect(await billState(fx, b2)).toMatchObject({
      status: 'approved', amountPaid: 0, paymentMatched: false,
    });
    expect(await paymentStatus(posted.journalEntryId)).toBe('cancelled');
    expect(await allocationCount(posted.journalEntryId)).toBe(0);
  }, 60000);

  it('reverses an over-payment, including the part that was left on account', async () => {
    const sup = await seedSupplier(fx, 'R3');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'R3', date: '2026-04-01', total: 100 });
    const tx = await seedBankTx(fx, { date: '2026-04-10', amount: -300, description: 'EFT-REV2' });

    const posted = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
    ));
    expect(posted.application!.onAccount).toBe(200);

    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));

    expect(await billState(fx, b1)).toMatchObject({ status: 'approved', amountPaid: 0 });
    expect(await paymentStatus(posted.journalEntryId)).toBe('cancelled');
  }, 60000);

  it('reverses a payment that was wholly on account', async () => {
    const sup = await seedSupplier(fx, 'R4');
    const tx = await seedBankTx(fx, { date: '2026-05-01', amount: -400, description: 'EFT-REV3' });

    const posted = await inTx(fx, () => allocateTransaction(
      fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
    ));
    await inTx(fx, () => reverseReconciledTransaction(fx.companyId, tx, fx.userId));

    expect(await paymentStatus(posted.journalEntryId)).toBe('cancelled');
  }, 60000);

  it('consumes the bills in turn across several lines of one batch', async () => {
    const sup = await seedSupplier(fx, 'S');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'S1', date: '2026-06-01', total: 100 });
    const b2 = await seedBill(fx, { supplierId: sup, number: 'S2', date: '2026-06-02', total: 200 });
    const b3 = await seedBill(fx, { supplierId: sup, number: 'S3', date: '2026-06-03', total: 300 });
    const txs = [
      await seedBankTx(fx, { date: '2026-06-10', amount: -150, description: 'BATCH-1' }),
      await seedBankTx(fx, { date: '2026-06-10', amount: -150, description: 'BATCH-2' }),
      await seedBankTx(fx, { date: '2026-06-10', amount: -150, description: 'BATCH-3' }),
    ];

    // One transaction, three lines, the shape the bulk tool posts in.
    const applied = await inTx(fx, async () => {
      const out: number[][] = [];
      for (const tx of txs) {
        const r = await allocateTransaction(
          fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
        );
        out.push(r.application!.applications.map((a) => a.amount));
      }
      return out;
    });

    // R450 over R100 + R200 + R300: line 1 closes B1 and starts B2, line 2
    // finishes B2 and starts B3, line 3 pays more of B3. A batch that planned
    // every line against the opening balances would have paid B1 three times.
    expect(applied).toEqual([[100, 50], [150], [150]]);
    expect(await billState(fx, b1)).toMatchObject({ status: 'paid', amountPaid: 100 });
    expect(await billState(fx, b2)).toMatchObject({ status: 'paid', amountPaid: 200 });
    expect(await billState(fx, b3)).toMatchObject({ status: 'partially_paid', amountPaid: 150 });
  }, 60000);

  it('rolls the whole batch back when one line fails', async () => {
    const sup = await seedSupplier(fx, 'T');
    const b1 = await seedBill(fx, { supplierId: sup, number: 'T1', date: '2026-07-01', total: 500 });
    const good = await seedBankTx(fx, { date: '2026-07-10', amount: -200, description: 'ROLL-1' });
    const missing = randomUUID();

    await expect(inTx(fx, async () => {
      await allocateTransaction(
        fx.companyId, good, null, fx.userId, undefined, 'supplier', sup,
      );
      // A transaction id this company does not have: the batch must take the
      // committed line with it rather than leave half a batch behind.
      await allocateTransaction(
        fx.companyId, missing, null, fx.userId, undefined, 'supplier', sup,
      );
    })).rejects.toThrow();

    expect(await billState(fx, b1)).toMatchObject({ status: 'approved', amountPaid: 0 });
  }, 60000);

  it('never lets two concurrent payments pay one bill twice', async () => {
    const sup = await seedSupplier(fx, 'U');
    const bill = await seedBill(fx, { supplierId: sup, number: 'U1', date: '2026-08-01', total: 100 });
    const txA = await seedBankTx(fx, { date: '2026-08-10', amount: -100, description: 'RACE-A' });
    const txB = await seedBankTx(fx, { date: '2026-08-10', amount: -100, description: 'RACE-B' });

    // The journals are posted FIRST, one after the other, and the race is run
    // over the application alone. Two concurrent `allocateTransaction` calls
    // cannot reach it: they collide on `uq_gl_je_company_entry_number` while
    // numbering their journals, which is a separate, pre-existing defect in
    // journal numbering and would be the only thing this test proved.
    const posted: string[] = [];
    for (const tx of [txA, txB]) {
      const r = await inTx(fx, () => allocateTransaction(
        fx.companyId, tx, null, fx.userId, undefined, 'supplier', sup,
        undefined, undefined, undefined, undefined, undefined, { autoApply: 'none' },
      ));
      posted.push(r.journalEntryId);
    }
    expect(await billState(fx, bill)).toMatchObject({ amountPaid: 0 });

    // A DETERMINISTIC overlap, not two calls raced by the scheduler: A takes
    // the locks and is held open while B runs, so B is forced to meet them.
    //
    // Without FOR UPDATE on the open-bill read, B reads the bill as wholly
    // open, plans R100 against it, and only then blocks — on the lock
    // `lockBillCandidates` takes. When A commits, B re-reads R0 outstanding
    // and REFUSES ("exceeds the outstanding"), which rolls back B's whole bank
    // allocation, journal included. With the lock, B waits before it plans and
    // simply finds nothing open. The bill reaches R100 either way; what this
    // asserts is that the second payment survives.
    const clientA = await fx.pool.connect();
    await clientA.query('BEGIN');
    const aRemainder = await runOn(fx, clientA, () => recordSupplierBankPayment({
      companyId: fx.companyId,
      supplierId: sup,
      bankTxId: txA,
      bankAccountId: fx.bankAccountId,
      journalEntryId: posted[0]!,
      amount: 100,
      paymentDate: '2026-08-10',
      description: 'RACE-A',
      userId: fx.userId,
    })).then((r) => r.unappliedRemainder);

    const clientB = await fx.pool.connect();
    await clientB.query('BEGIN');
    const bRunning = runOn(fx, clientB, () => recordSupplierBankPayment({
      companyId: fx.companyId,
      supplierId: sup,
      bankTxId: txB,
      bankAccountId: fx.bankAccountId,
      journalEntryId: posted[1]!,
      amount: 100,
      paymentDate: '2026-08-10',
      description: 'RACE-B',
      userId: fx.userId,
    })).then((r) => r.unappliedRemainder);

    // Long enough for B to reach the bill and block on it.
    await new Promise((resolve) => { setTimeout(resolve, 300); });
    await clientA.query('COMMIT');
    clientA.release();

    const bRemainder = await bRunning;
    await clientB.query('COMMIT');
    clientB.release();

    const state = await billState(fx, bill);
    expect(state.amountPaid).toBe(100);
    expect(state.status).toBe('paid');
    // A settled it; B found nothing open and stayed on account in full.
    expect([aRemainder, bRemainder]).toEqual([0, 100]);
  }, 60000);
});
