/**
 * BREAKER 7a: adjust_credit_note_application lowers an application and leaves the bill open; the back-fill
 * (auto_apply_unapplied) then re-plans that same bill for the same note and dies on UNIQUE(credit_note_id, invoice_id).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { adjustCreditNoteApplication } from '@/modules/accounting/services/shared/creditNoteApplicationAdjust';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedBill, seedFixture, seedSupplier, type Fixture } from './helpers/l1FifoFixture';
import { seedPostedNote } from './helpers/creditNoteJournalFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: Fixture;

describeIfDb('breaker 7a back-fill after adjust', () => {
  beforeAll(async () => { assertNotProductionDb('breaker'); fx = await seedFixture('BRK7B', DATABASE_URL!); }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx).catch(() => undefined);
  }, 120000);

  it('adjust down to 30 on a R200 bill, then auto_apply_unapplied applies the rest to the same bill', async () => {
    const sup = await seedSupplier(fx, 'BF');
    const bill = await seedBill(fx, { number: 'BF1', date: '2026-02-01', total: 200, supplierId: sup });
    const note = await seedPostedNote(fx, { side: 'supplier', number: 'NBF', total: 100, posted: 100, counterpartyId: sup });
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 100 }, fx.userId));
    await inTx(fx, () => adjustCreditNoteApplication(fx.companyId, { creditNoteId: note, documentId: bill, newAmount: 30 }, fx.userId));
    const run = await inTx(fx, () => autoApplyUnapplied({
      companyId: fx.companyId, userId: fx.userId, subledger: 'ap', entityId: sup, dryRun: false, idempotencyKey: `bf-${fx.tag}`,
    }));
    expect(run.failed).toEqual([]);
    const r = ((await sql`SELECT applied_amount FROM credit_notes WHERE id = ${note}::UUID`) as Record<string, unknown>[])[0]!;
    expect(Number(r.applied_amount)).toBe(100);
  });
});
