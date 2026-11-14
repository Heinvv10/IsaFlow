/**
 * BREAKER 7a: everyday customer flow with REAL approvals — FIFO over several invoices, partial unapply,
 * apply_credit_note, REST apply, auto_apply_unapplied over many notes, cancel. Nothing legit may be refused.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from '@/lib/neon';
import { applyCreditNoteToDocument } from '@/modules/accounting/services/shared/creditNoteDocumentApply';
import { unapplyCreditNote } from '@/modules/accounting/services/shared/creditNoteUnapply';
import { autoApplyUnapplied } from '@/modules/accounting/services/shared/autoApplyBackfillService';
import { createCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteApproveService';
import { applyCreditNoteToInvoice } from '@/modules/accounting/services/ar/creditNoteApplyToInvoice';
import { cancelCreditNote } from '@/modules/accounting/services/ar/creditNoteCancelService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { dropFixture, inTx, seedFixture, seedInvoice, type Fixture } from './helpers/l1FifoFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
let fx: Fixture;

const paid = async (id: string) =>
  Number(((await sql`SELECT amount_paid FROM customer_invoices WHERE id = ${id}::UUID`) as Record<string, unknown>[])[0]!.amount_paid);
async function totals() {
  const r = ((await sql`
    SELECT (SELECT COALESCE(SUM(applied_amount),0) FROM credit_notes WHERE company_id = ${fx.companyId}::UUID AND status <> 'cancelled') AS applied,
           (SELECT COALESCE(SUM(amount_allocated),0) FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID) AS rows,
           (SELECT COALESCE(SUM(amount_paid),0) FROM customer_invoices WHERE company_id = ${fx.companyId}::UUID) AS paid`) as Record<string, unknown>[])[0]!;
  return { applied: Number(r.applied), rows: Number(r.rows), paid: Number(r.paid) };
}
async function newNote(subtotal: number, mode: 'fifo' | 'none') {
  const n = await inTx(fx, () => createCreditNote(fx.companyId, {
    type: 'customer', clientId: fx.customerId, creditDate: '2026-03-01', subtotal, taxRate: 15,
  }, fx.userId));
  await inTx(fx, () => approveCreditNote(fx.companyId, n.id, fx.userId, { autoApply: mode }));
  return n.id;
}

describeIfDb('breaker 7a everyday', () => {
  beforeAll(async () => {
    assertNotProductionDb('breaker');
    fx = await seedFixture('BRK7E', DATABASE_URL!);
    await sql`
      INSERT INTO gl_accounts (company_id, account_code, account_name, account_type, account_subtype,
                               normal_balance, is_active, is_system_account)
      VALUES (${fx.companyId}::UUID, '4000', ${`Revenue ${fx.tag}`}, 'revenue', 'default_revenue', 'credit', true, true)`;
  }, 120000);
  afterAll(async () => {
    await sql`DELETE FROM credit_note_allocations WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM credit_notes WHERE company_id = ${fx.companyId}::UUID`;
    await dropFixture(fx).catch(() => undefined);
  }, 120000);

  it('FIFO over three invoices, partial unapply, re-apply by name, REST apply, back-fill, cancel', async () => {
    const i1 = await seedInvoice(fx, { number: 'E1', date: '2026-01-10', total: 33.33 });
    const i2 = await seedInvoice(fx, { number: 'E2', date: '2026-01-11', total: 40.01 });
    const i3 = await seedInvoice(fx, { number: 'E3', date: '2026-01-12', total: 500 });
    const n1 = await newNote(86.97, 'fifo'); // total 100.02
    expect(await paid(i1)).toBe(33.33);
    expect(await paid(i2)).toBe(40.01);
    expect(await paid(i3)).toBe(26.68);

    await inTx(fx, () => unapplyCreditNote(fx.companyId, { creditNoteId: n1, invoiceId: i2 }, fx.userId));
    await inTx(fx, () => applyCreditNoteToDocument(fx.companyId, { creditNoteId: n1, invoiceId: i2, amount: 10 }, fx.userId));
    const i4 = await seedInvoice(fx, { number: 'E4', date: '2026-01-13', total: 7 });
    await inTx(fx, () => applyCreditNoteToInvoice(fx.companyId, n1, i4, fx.userId));

    const many: string[] = [];
    for (let k = 0; k < 6; k++) many.push(await newNote(10 + k * 0.37, 'none'));
    const run = await inTx(fx, () => autoApplyUnapplied({
      companyId: fx.companyId, userId: fx.userId, subledger: 'ar', entityId: fx.customerId, dryRun: false, idempotencyKey: `brk-${fx.tag}`,
    }));
    // FINDING (pre-existing, made reachable by partial apply / adjust down): n1 already has a row on open i2,
    // the back-fill's FIFO walk re-plans i2 and hits UNIQUE(credit_note_id, invoice_id) -> 'database error 23505'.
    expect.soft(run.failed).toEqual([]);
    const t = await totals();
    expect(t.applied).toBeCloseTo(t.rows, 2);
    expect(t.paid).toBeCloseTo(t.rows, 2);

    for (const id of [n1, ...many]) await inTx(fx, () => cancelCreditNote(fx.companyId, id, fx.userId));
    expect(await totals()).toEqual({ applied: 0, rows: 0, paid: 0 });
    // GL: every note journal reversed — AR net zero.
    const ar = ((await sql`
      SELECT COALESCE(SUM(jl.debit - jl.credit),0) AS net FROM gl_journal_lines jl
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE jl.company_id = ${fx.companyId}::UUID AND ga.account_subtype = 'receivable'`) as Record<string, unknown>[])[0]!;
    expect(Number(ar.net)).toBe(0);
  });
});
