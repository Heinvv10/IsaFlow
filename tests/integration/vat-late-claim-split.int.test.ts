/**
 * A bill dated inside a filed (locked) VAT period, approved by a person who
 * opts in, posts as the s16(3) late input-VAT claim: the filed period's VAT201
 * does not move, the next open period's input tax goes up by exactly the bill's
 * VAT, and the clearing account nets to nil. Without the opt-in it is refused
 * exactly as before.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from '@/lib/neon';
import { approveSupplierInvoice } from '@/modules/accounting/services/ap/supplierInvoiceWorkflowService';
import { VatPeriodLockedError } from '@/modules/accounting/services/gl/journalVatLockGuard';
import { createJournalEntry, postJournalEntry } from '@/modules/accounting/services/gl/journalEntryService';
import { getVat201Report } from '@/modules/accounting/services/reports/vat201ReportService';
import { assertNotProductionDb } from '../helpers/assertNotProductionDb';
import { inTx } from './helpers/l1FifoFixture';
import {
  NEXT, P, balanceOf, countRows, draftBill, dropLateFixture, lockPeriod, seedLateFixture, vatFigures,
  type LateFixture,
} from './helpers/vatLateClaimFixture';

const DATABASE_URL = process.env.DATABASE_URL;
const describeIfDb = DATABASE_URL ? describe : describe.skip;
type Row = Record<string, unknown>;
let fx: LateFixture;

describeIfDb('late input VAT claim: the split', () => {
  beforeAll(async () => {
    assertNotProductionDb('This test posts into a locked VAT period.');
    fx = await seedLateFixture('VLC', DATABASE_URL!);
    // A bill filed in P, so the locked figures are not all zero.
    const filed = await draftBill(fx, '2026-05-20');
    await inTx(fx, () => approveSupplierInvoice(fx.companyId, filed.id, fx.userId));
    await lockPeriod(fx, P.start, P.end);
  }, 120000);

  afterAll(async () => { if (fx) await dropLateFixture(fx); }, 120000);

  it('without the opt-in: refused exactly as today, nothing written', async () => {
    const bill = await draftBill(fx, '2026-06-12');
    const before = await countRows(fx);
    const err = await inTx(fx, () => approveSupplierInvoice(fx.companyId, bill.id, fx.userId))
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(VatPeriodLockedError);
    expect((err as Error).name).toBe('VatPeriodLockedError');
    expect(await countRows(fx)).toEqual(before);
    const [row] = (await sql`SELECT status, gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[];
    expect(row).toEqual({ status: 'draft', gl_journal_entry_id: null });
  });

  it('opted in: the filed period does not move, the next one claims exactly the VAT', async () => {
    const bill = await draftBill(fx, '2026-06-12');
    const pBefore = await vatFigures(fx, P.start, P.end);
    const nextBefore = await vatFigures(fx, NEXT.start, NEXT.end);

    const approved = await inTx(fx, () =>
      approveSupplierInvoice(fx.companyId, bill.id, fx.userId, { allowLateInputClaim: true }));

    expect(approved.status).toBe('approved');
    expect(approved.lateClaim).toMatchObject({
      claimDate: '2026-07-01', lockPeriod: { start: P.start, end: P.end }, inputTax: 150,
    });
    const pAfter = await vatFigures(fx, P.start, P.end);
    expect({ ...pAfter, postedThrough: '' }).toEqual({ ...pBefore, postedThrough: '' });
    const nextAfter = await vatFigures(fx, NEXT.start, NEXT.end);
    expect(nextAfter.inputTax - nextBefore.inputTax).toBeCloseTo(150, 2);
    expect(nextAfter.outputTax).toBe(nextBefore.outputTax);
    expect(await balanceOf(fx, fx.clearingId)).toBe(0);

    // The bill keeps the ORIGINAL; the companion points back at it and carries no document.
    const [b] = (await sql`SELECT gl_journal_entry_id FROM supplier_invoices WHERE id = ${bill.id}::UUID`) as Row[];
    const [comp] = (await sql`
      SELECT id, entry_date::TEXT AS d, source, status, late_claim_of_id, source_record_id, source_document_id
      FROM gl_journal_entries WHERE id = ${approved.lateClaim!.companionEntryId}::UUID`) as Row[];
    expect(comp).toMatchObject({
      d: '2026-07-01', source: 'auto_vat_late_claim', status: 'posted',
      late_claim_of_id: b!.gl_journal_entry_id, source_record_id: null, source_document_id: null,
    });
    // The original: dated in P, posted, no VAT code or VAT Input line left.
    const orig = (await sql`
      SELECT jl.vat_type, ga.account_subtype, je.entry_date::TEXT AS d, je.status
      FROM gl_journal_lines jl JOIN gl_journal_entries je ON je.id = jl.journal_entry_id
      JOIN gl_accounts ga ON ga.id = jl.gl_account_id
      WHERE je.id = ${b!.gl_journal_entry_id as string}::UUID`) as Row[];
    expect(orig.every((l) => l.d === '2026-06-12' && l.status === 'posted' && l.vat_type === null)).toBe(true);
    expect(orig.map((l) => l.account_subtype)).not.toContain('vat_input');
    expect(orig.map((l) => l.account_subtype)).toContain('vat_input_late_claim');
  });

  it('the claim period\'s VAT201 ties: the companion is in box 15 without breaking the 15% check', async () => {
    const r = await inTx(fx, () => getVat201Report(fx.companyId, NEXT.start, NEXT.end, { detail: 'summary' }));
    expect(r.totals.lateClaimInputTax).toBe(150);
    expect(r.rateCheck.entriesWithoutBase).toEqual([]);
    const box15 = r.boxes.find((b) => b.box === '15')!;
    expect(box15).toMatchObject({ tax: 150, lateClaimTax: 150, variance: 0 });
    expect(r.rateCheck.ties).toBe(true);
  });

  it('a manual journal whose BASE line carries a VAT code splits too (the code comes off the original)', async () => {
    const lines = [
      { glAccountId: fx.expenseId, debit: 200, credit: 0, vatType: 'standard' as const },
      { glAccountId: fx.vatInputId, debit: 30, credit: 0, vatType: 'standard' as const },
      { glAccountId: fx.apId, debit: 0, credit: 230 },
    ];
    const posted = await inTx(fx, async () => {
      const je = await createJournalEntry(fx.companyId, { entryDate: '2026-06-20', description: 'LC manual', lines },
        fx.userId, undefined, { allowLateInputClaim: true });
      return postJournalEntry(fx.companyId, je.id, fx.userId, { allowLateInputClaim: true });
    });
    expect(posted.status).toBe('posted');
    expect(posted.lateClaim).toMatchObject({ claimDate: '2026-07-01', inputTax: 30 });
    const tags = (await sql`
      SELECT vat_type FROM gl_journal_lines WHERE journal_entry_id = ${posted.id}::UUID`) as Row[];
    expect(tags.map((t) => t.vat_type)).toEqual([null, null, null]);
    const [c] = (await sql`
      SELECT vat_type FROM gl_journal_lines WHERE journal_entry_id = ${posted.lateClaim!.companionEntryId}::UUID
        AND gl_account_id = ${fx.vatInputId}::UUID`) as Row[];
    expect(c!.vat_type).toBe('standard');
    expect(await balanceOf(fx, fx.clearingId)).toBe(0);
  });
});
