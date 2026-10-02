/**
 * A late-claimed bill is dated by its companion (gl/vatLateClaimSplit) only
 * while the companion STANDS as at the period end: an EVEN number of the
 * posted entries in its reversal chain (R reverses C, R2 reverses R, ...) are
 * dated on or before that date. The one-link `reversed_at IS NULL` read a
 * companion whose reversal was itself reversed as reversed for ever, so the
 * bill fell back to its invoice date and re-entered the FILED period's return,
 * and it read a companion reversed only in a LATER period as reversed in the
 * claim period too.
 *
 * The product cannot build either chain today — a companion is reversed only
 * with its original (LateClaimCompanionReversalError), and a reversal of that
 * reversal faces the clearing-account guard — so the chain is written in SQL,
 * the way k053-out-of-order-reversal-chain does, standing for a script repair
 * or an imported ledger.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'crypto';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { generateVAT201 } from '@/modules/accounting/services/reports/vat201Service';
import { getVatExceptions } from '@/modules/accounting/services/reports/vatExceptionsService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  NEXT, P, draftBill, dropLateFixture, lockPeriod, seedLateFixture, type LateFixture,
} from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
const LATER = { start: '2026-09-01', end: '2026-10-31' } as const;
let fx: LateFixture;
let seq = 0;

async function lateBill(date: string): Promise<{ billId: string; companionId: string }> {
  const bill = await draftBill(fx, date, { vatClassification: 'services' });
  const approved = await inTx(fx, () =>
    approveSupplierInvoice(fx.companyId, bill.id, fx.userId, { allowLateInputClaim: true }));
  expect(approved.lateClaim?.claimDate).toBe(NEXT.start);
  return { billId: bill.id, companionId: approved.lateClaim!.companionEntryId };
}

/** A posted contra of `ofId` dated `date`, marking `ofId` reversed as reverseJournalEntry does. */
async function contra(ofId: string, date: string): Promise<string> {
  const id = randomUUID();
  await sql`
    INSERT INTO gl_journal_entries (id, company_id, entry_number, entry_date, description,
      status, source, reversal_of_id, created_by)
    VALUES (${id}::UUID, ${fx.companyId}::UUID, ${`JE-D8-${++seq}-${fx.tag}`.slice(0, 50)}, ${date}::DATE,
      'hand-built reversal', 'posted', 'auto_vat_late_claim', ${ofId}::UUID, ${fx.userId}::UUID)`;
  await sql`
    INSERT INTO gl_journal_lines (company_id, journal_entry_id, gl_account_id, debit, credit, description, vat_type)
    SELECT company_id, ${id}::UUID, gl_account_id, credit, debit, description, vat_type
    FROM gl_journal_lines WHERE journal_entry_id = ${ofId}::UUID AND company_id = ${fx.companyId}::UUID`;
  await sql`
    UPDATE gl_journal_entries SET reversed_at = NOW(), reversed_by = ${fx.userId}
    WHERE id = ${ofId}::UUID AND company_id = ${fx.companyId}::UUID`;
  return id;
}

const inputIds = async (start: string, end: string) =>
  (await inTx(fx, () => generateVAT201(fx.companyId, start, end))).inputInvoices.map((i) => i.id);

const mismatchIds = async (start: string, end: string) =>
  (await inTx(fx, () => getVatExceptions(fx.companyId, start, end))).invoiceGlMismatches.map((m) => m.invoiceId);

describeIfDb('late input VAT claim: a companion is dated by its chain parity as at the period end', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    fx = await seedLateFixture('VLR', DATABASE_URL!);
    await lockPeriod(fx, P.start, P.end);
  }, 120000);

  afterAll(async () => { if (fx) await dropLateFixture(fx); }, 120000);

  it('a companion reversed and re-reversed inside the claim period still files the bill there, not in the filed period', async () => {
    const { billId, companionId } = await lateBill('2026-06-12');
    const r = await contra(companionId, '2026-07-10');
    await contra(r, '2026-07-20');

    expect(await inputIds(NEXT.start, NEXT.end)).toContain(billId);
    expect(await inputIds(P.start, P.end)).not.toContain(billId);

    // The exceptions report dates the bill the same way: a bill-vs-GL VAT
    // difference surfaces in the claim period, never in the filed one.
    await sql`UPDATE supplier_invoices SET tax_amount = tax_amount + 1 WHERE id = ${billId}::UUID`;
    try {
      expect(await mismatchIds(NEXT.start, NEXT.end)).toContain(billId);
      expect(await mismatchIds(P.start, P.end)).not.toContain(billId);
    } finally {
      await sql`UPDATE supplier_invoices SET tax_amount = tax_amount - 1 WHERE id = ${billId}::UUID`;
    }
  });

  it('a companion reversed only in a LATER period still stands as at the claim period end', async () => {
    const { billId, companionId } = await lateBill('2026-06-15');
    await contra(companionId, '2026-09-05');

    expect(await inputIds(NEXT.start, NEXT.end)).toContain(billId);
    expect(await inputIds(P.start, P.end)).not.toContain(billId);
    // As at the later period's end the claim is reversed: the bill is not
    // dated into that period by a companion that no longer stands.
    expect(await inputIds(LATER.start, LATER.end)).not.toContain(billId);
  });

  it('a companion reversed inside the claim period dates its bill into neither period', async () => {
    const { billId, companionId } = await lateBill('2026-06-18');
    await contra(companionId, '2026-07-10');

    expect(await inputIds(NEXT.start, NEXT.end)).not.toContain(billId);
    // As at the filed period's end the companion stood (its reversal is
    // dated later), so the bill is not pulled back into the filed return: its
    // VAT sits on the clearing account, in no box, exactly as the GL has it.
    expect(await inputIds(P.start, P.end)).not.toContain(billId);
  });
});
