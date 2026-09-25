/**
 * A late-claimed journal is undone as a PAIR: reversing the original (or
 * cancelling its bill) reverses the companion too, on the companion's own date,
 * so the clearing account and the claim period's input VAT both net to nil.
 * The companion is never reversed on its own — through the service or the
 * route (400, nothing written).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice, cancelSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { planSupplierInvoiceCancel } from '@/modules/accounting/services/ap/supplierInvoiceCancelPlan';
import { reverseJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { LateClaimCompanionReversalError } from '@/modules/accounting/services/gl/vatLateClaimSplit';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { request, response } from './mfa-impersonation-postgres.helpers';
import { inTx } from './helpers/l1FifoFixture';
import {
  NEXT, P, balanceOf, countRows, draftBill, dropLateFixture, lockPeriod, seedLateFixture, vatFigures,
  type LateFixture,
} from './helpers/vatLateClaimFixture';
import journalEntriesAction from '../../pages/api/accounting/journal-entries-action';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL && process.env.JWT_SECRET ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;
let token = '';

async function lateBill(date = '2026-06-12') {
  const bill = await draftBill(fx, date);
  const approved = await inTx(fx, () =>
    approveSupplierInvoice(fx.companyId, bill.id, fx.userId, { allowLateInputClaim: true }));
  const [row] = (await sql`SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[];
  return { billId: bill.id, originalId: String(row!.gl_journal_entry_id), companionId: approved.lateClaim!.companionEntryId };
}

const reversedAt = async (id: string) => ((await sql`
  SELECT reversed_at FROM gl_journal_entries WHERE id = ${id}::UUID`) as Row[])[0]!.reversed_at;

describeIfDb('late input VAT claim: reversal and cancel', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    fx = await seedLateFixture('VLV', DATABASE_URL!);
    await sql`INSERT INTO users (id, email, role, is_active) VALUES (${fx.userId}, ${`vlv-${fx.userId}@isaflow.test`}, 'admin', true)`;
    await sql`INSERT INTO company_users (company_id, user_id, role) VALUES (${fx.companyId}::UUID, ${fx.userId}, 'admin')`;
    token = await new SignJWT({ sub: fx.userId, aal: 'aal2' })
      .setProtectedHeader({ alg: 'HS256' }).setExpirationTime('1h')
      .sign(new TextEncoder().encode(process.env.JWT_SECRET));
    await lockPeriod(fx, P.start, P.end);
  }, 120000);

  afterAll(async () => {
    if (!fx) return;
    await sql`DELETE FROM company_document_numbers WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM company_users WHERE company_id = ${fx.companyId}::UUID`;
    await sql`DELETE FROM users WHERE id = ${fx.userId}`;
    await dropLateFixture(fx);
  }, 120000);

  it('the companion alone is refused — service and route (400) — and nothing is written', async () => {
    const { companionId } = await lateBill();
    const before = await countRows(fx);
    await expect(inTx(fx, () => reverseJournalEntry(fx.companyId, companionId, fx.userId)))
      .rejects.toBeInstanceOf(LateClaimCompanionReversalError);
    const req = request({ 'sb-access-token': token, active_company_id: fx.companyId }, 'POST') as never as
      { body: unknown; query: Record<string, string>; url: string };
    req.body = { id: companionId, action: 'reverse' };
    req.query = {};
    req.url = '/api/accounting/journal-entries-action';
    const out = response();
    await journalEntriesAction(req as never, out.res as never);
    expect(out.state.statusCode).toBe(400);
    expect(JSON.stringify(out.state.body)).toMatch(/late input-VAT claim/);
    expect(await countRows(fx)).toEqual(before);
    expect(await reversedAt(companionId)).toBeNull();
  });

  it('reversing the original reverses the companion on its own date; everything nets to nil', async () => {
    const nextBefore = await vatFigures(fx, NEXT.start, NEXT.end);
    const pBefore = await vatFigures(fx, P.start, P.end);
    const clearingBefore = await balanceOf(fx, fx.clearingId);
    const { originalId, companionId } = await lateBill();
    const rev = await inTx(fx, () => reverseJournalEntry(fx.companyId, originalId, fx.userId));
    expect(rev.entryDate).toBe('2026-06-12');
    expect(rev.lateClaimReversal).toBeDefined();
    expect(rev.lateClaimReversal!.entryDate).toBe('2026-07-01');
    expect(await reversedAt(companionId)).not.toBeNull();
    expect(await balanceOf(fx, fx.clearingId)).toBe(clearingBefore);
    const nextAfter = await vatFigures(fx, NEXT.start, NEXT.end);
    expect(nextAfter.inputTax).toBeCloseTo(nextBefore.inputTax, 2);
    const pAfter = await vatFigures(fx, P.start, P.end);
    expect({ ...pAfter, postedThrough: '' }).toEqual({ ...pBefore, postedThrough: '' });
  });

  it('cancelling the bill previews and then reverses both; clearing and the claim period net to nil', async () => {
    const nextBefore = await vatFigures(fx, NEXT.start, NEXT.end);
    const clearingBefore = await balanceOf(fx, fx.clearingId);
    const { billId, originalId, companionId } = await lateBill();
    const plan = await inTx(fx, () => planSupplierInvoiceCancel(fx.companyId, billId));
    expect(plan.journal?.id).toBe(originalId);
    expect(plan.journal?.lateClaim).toMatchObject({ id: companionId, reversalDate: '2026-07-01', vatLockRoll: null });

    await inTx(fx, () => cancelSupplierInvoice(fx.companyId, billId, fx.userId));
    expect(await reversedAt(originalId)).not.toBeNull();
    expect(await reversedAt(companionId)).not.toBeNull();
    expect(await balanceOf(fx, fx.clearingId)).toBe(clearingBefore);
    const nextAfter = await vatFigures(fx, NEXT.start, NEXT.end);
    expect(nextAfter.inputTax).toBeCloseTo(nextBefore.inputTax, 2);
  });

  it('when the claim period has since been filed too, the companion\'s reversal rolls past that lock', async () => {
    const { billId, companionId } = await lateBill();
    await lockPeriod(fx, NEXT.start, NEXT.end);
    try {
      const plan = await inTx(fx, () => planSupplierInvoiceCancel(fx.companyId, billId));
      expect(plan.journal?.lateClaim?.reversalDate).toBe('2026-09-01');
      expect(plan.journal?.lateClaim?.vatLockRoll?.rolledFrom).toBe('2026-07-01');
      await inTx(fx, () => cancelSupplierInvoice(fx.companyId, billId, fx.userId));
      const [r] = (await sql`
        SELECT entry_date::TEXT AS d FROM gl_journal_entries WHERE reversal_of_id = ${companionId}::UUID`) as Row[];
      expect(r!.d).toBe('2026-09-01');
    } finally {
      await sql`DELETE FROM vat_period_locks WHERE company_id = ${fx.companyId}::UUID AND period_start = ${NEXT.start}::DATE`;
    }
  });
});
