/**
 * L2 — the aged report and the statement must agree about one entity.
 *
 * They are the two documents a person uses to answer the same question, and
 * before this they could not agree: the statement netted every live credit note
 * and every payment at face value, while the aged report bucketed open
 * documents and named the unapplied cash only in a company-wide footer. An
 * entity carrying on-account credit therefore read as owing more on the aged
 * report than its own statement said.
 *
 * The scenario is the one that breaks a naive netting: two bills, a credit note
 * that FIFO could only partly place, a payment nobody applied, and a bill raised
 * AFTER all of it so the gross is not trivially zero.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import {
  setupFixture, makeBill, makeInvoice, makeDraftNote, noteState, type Fixture,
} from './l2-credit-note-fifo.helpers';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { getAPAging } from '@/modules/accounting/services/ap/apAgingService';
import { getARAging } from '@/modules/accounting/services/ar/arAgingService';
import { fetchSupplierStatementData } from '@/modules/accounting/services/ap/supplierStatementService';
import { fetchStatementData } from '@/modules/accounting/services/ar/statementEmailService';
import {
  getUnappliedByEntity, getUnappliedCreditNotes, netAgingRows,
} from '@/modules/accounting/services/shared/agedNetting';

const describeIfDb = process.env.DATABASE_URL ? describe : describe.skip;
const AS_AT = '2026-12-31';

let f: Fixture;

async function netFor(side: 'ar' | 'ap', entityId: string): Promise<number> {
  const gross = side === 'ap'
    ? await getAPAging(f.company, AS_AT)
    : await getARAging(f.company, AS_AT);
  const rows = netAgingRows(gross, await getUnappliedByEntity(f.company, side, AS_AT));
  return rows.find((r) => r.entityId === entityId)?.net ?? 0;
}

describeIfDb('L2 aged net agrees with the statement', () => {
  beforeAll(async () => { f = await setupFixture('L2NET'); }, 60000);
  afterAll(async () => { await f.cleanup(); }, 60000);

  it('AP — the supplier statement closing balance equals the aged net', async () => {
    await makeBill(f, 'L2N-AP-1', 1000, '2026-03-01');
    await makeBill(f, 'L2N-AP-2', 2000, '2026-04-01');
    // 3500 of credit against 3000 of open bills: 500 cannot be placed.
    const note = await makeDraftNote(f, {
      type: 'supplier', number: 'L2N-AP-CN', total: 3500, creditDate: '2026-05-01',
    });
    await f.inTx(() => approveCreditNote(f.company, note, f.user));
    expect(await noteState(f, note)).toMatchObject({ status: 'partially_applied', applied: 3000 });

    // Cash paid to the supplier that nobody applied to a bill.
    await f.pool.query(
      `INSERT INTO supplier_payments(id,company_id,supplier_id,payment_date,total_amount,
         payment_method,status,created_by)
       VALUES($1,$2,$3,'2026-06-01',300,'eft','processed',$4)`,
      [randomUUID(), f.company, f.supplier, f.user]);

    // Raised after everything above, so the gross is a real number rather than
    // the zero the credit happens to leave behind.
    await makeBill(f, 'L2N-AP-3', 800, '2026-07-01');

    const statement = await fetchSupplierStatementData(f.company, f.supplier, AS_AT);
    const net = await netFor('ap', f.supplier);

    // 3800 billed − 300 paid − 3500 credited = 0.
    expect(statement!.summary.balance).toBeCloseTo(0, 2);
    expect(net).toBeCloseTo(statement!.summary.balance, 2);

    // …and the netting is doing real work: the gross still shows the open bill.
    const gross = (await getAPAging(f.company, AS_AT)).find((r) => r.entityId === f.supplier);
    expect(gross!.total).toBeCloseTo(800, 2);
  }, 60000);

  it('AP — the unapplied credit-note figure names exactly the remainder', async () => {
    const summary = await getUnappliedCreditNotes(f.company, 'supplier', AS_AT);
    expect(summary.count).toBe(1);
    expect(summary.amount).toBeCloseTo(500, 2);
    expect(summary.sample[0]!.entityId).toBe(f.supplier);
  }, 60000);

  it('AR — the customer statement closing balance equals the aged net', async () => {
    await makeInvoice(f, 'L2N-AR-1', 1000, '2026-03-01');
    await makeInvoice(f, 'L2N-AR-2', 2000, '2026-04-01');
    const note = await makeDraftNote(f, {
      type: 'customer', number: 'L2N-AR-CN', total: 3500, creditDate: '2026-05-01',
    });
    await f.inTx(() => approveCreditNote(f.company, note, f.user));
    expect(await noteState(f, note)).toMatchObject({ status: 'partially_applied', applied: 3000 });

    await f.pool.query(
      `INSERT INTO customer_payments(id,company_id,client_id,payment_date,total_amount,
         payment_method,status,created_by)
       VALUES($1,$2,$3,'2026-06-01',300,'eft','confirmed',$4)`,
      [randomUUID(), f.company, f.customer, f.user]);

    await makeInvoice(f, 'L2N-AR-3', 800, '2026-07-01');

    const statement = await fetchStatementData(f.company, f.customer, AS_AT);
    const net = await netFor('ar', f.customer);

    expect(statement!.summary.balance).toBeCloseTo(0, 2);
    expect(net).toBeCloseTo(statement!.summary.balance, 2);

    const gross = (await getARAging(f.company, AS_AT)).find((r) => r.entityId === f.customer);
    expect(gross!.total).toBeCloseTo(800, 2);
  }, 60000);

  it('the netted row carries the credit as a NEGATIVE beside the gross buckets', async () => {
    const rows = netAgingRows(
      await getAPAging(f.company, AS_AT),
      await getUnappliedByEntity(f.company, 'ap', AS_AT),
    );
    const row = rows.find((r) => r.entityId === f.supplier)!;
    // 500 of credit-note remainder plus 300 of unapplied cash.
    expect(row.unapplied).toBeCloseTo(-800, 2);
    expect(row.total).toBeCloseTo(800, 2);
    expect(row.net).toBeCloseTo(0, 2);
    // The buckets are untouched by the netting — they still sum to the gross.
    expect(row.current + row.days30 + row.days60 + row.days90 + row.days120Plus)
      .toBeCloseTo(row.total, 2);
  }, 60000);
});
